pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract RentAssetFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    mapping(uint256 => bool) public isBatchClosed;

    struct RentalAgreement {
        euint32 assetIdEncrypted;
        euint32 rentalPricePerDayEncrypted;
        euint32 rentalDurationDaysEncrypted;
        euint32 collateralAmountEncrypted;
        ebool isActiveEncrypted;
    }
    mapping(uint256 => RentalAgreement) public rentalAgreements; // batchId => agreement

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address account);
    event Unpaused(address account);
    event CooldownSecondsSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 batchId);
    event BatchClosed(uint256 batchId);
    event RentalAgreementSubmitted(address indexed provider, uint256 batchId);
    event DecryptionRequested(uint256 indexed requestId, uint256 batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 batchId, uint256 assetId, uint256 rentalPricePerDay, uint256 rentalDurationDays, uint256 collateralAmount, bool isActive);

    error NotOwner();
    error NotProvider();
    error PausedError();
    error CooldownActive();
    error BatchClosedError();
    error InvalidBatch();
    error ReplayError();
    error StateMismatchError();
    error DecryptionFailedError();
    error NotInitializedError();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedError();
        _;
    }

    modifier checkCooldown(address _address, uint256 _cooldownMapping) {
        if (block.timestamp < _cooldownMapping) revert CooldownActive();
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        currentBatchId = 1; // Start with batch 1
        cooldownSeconds = 60; // Default 1 minute cooldown
    }

    function transferOwnership(address newOwner) public onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addProvider(address provider) public onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) public onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function pause() public onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() public onlyOwner {
        if (!paused) revert PausedError(); // Revert if already unpaused
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) public onlyOwner {
        emit CooldownSecondsSet(cooldownSeconds, newCooldownSeconds);
        cooldownSeconds = newCooldownSeconds;
    }

    function openBatch() public onlyOwner {
        currentBatchId++;
        isBatchClosed[currentBatchId] = false;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch(uint256 batchId) public onlyOwner {
        if (batchId == 0 || batchId > currentBatchId) revert InvalidBatch();
        if (isBatchClosed[batchId]) revert BatchClosedError();
        isBatchClosed[batchId] = true;
        emit BatchClosed(batchId);
    }

    function submitRentalAgreement(
        euint32 _assetIdEncrypted,
        euint32 _rentalPricePerDayEncrypted,
        euint32 _rentalDurationDaysEncrypted,
        euint32 _collateralAmountEncrypted,
        ebool _isActiveEncrypted
    ) external onlyProvider whenNotPaused checkCooldown(msg.sender, lastSubmissionTime[msg.sender]) {
        if (isBatchClosed[currentBatchId]) revert BatchClosedError();

        if (!_assetIdEncrypted.isInitialized()) revert NotInitializedError();
        if (!_rentalPricePerDayEncrypted.isInitialized()) revert NotInitializedError();
        if (!_rentalDurationDaysEncrypted.isInitialized()) revert NotInitializedError();
        if (!_collateralAmountEncrypted.isInitialized()) revert NotInitializedError();
        if (!_isActiveEncrypted.isInitialized()) revert NotInitializedError();

        rentalAgreements[currentBatchId] = RentalAgreement({
            assetIdEncrypted: _assetIdEncrypted,
            rentalPricePerDayEncrypted: _rentalPricePerDayEncrypted,
            rentalDurationDaysEncrypted: _rentalDurationDaysEncrypted,
            collateralAmountEncrypted: _collateralAmountEncrypted,
            isActiveEncrypted: _isActiveEncrypted
        });

        lastSubmissionTime[msg.sender] = block.timestamp + cooldownSeconds;
        emit RentalAgreementSubmitted(msg.sender, currentBatchId);
    }

    function requestRentalAgreementDecryption(uint256 batchId) external whenNotPaused checkCooldown(msg.sender, lastDecryptionRequestTime[msg.sender]) {
        if (batchId == 0 || batchId > currentBatchId) revert InvalidBatch();
        if (!isBatchClosed[batchId]) revert BatchClosedError(); // Only decrypt closed batches

        RentalAgreement storage agreement = rentalAgreements[batchId];

        // 1. Prepare Ciphertexts
        bytes32[] memory cts = new bytes32[](5);
        cts[0] = agreement.assetIdEncrypted.toBytes32();
        cts[1] = agreement.rentalPricePerDayEncrypted.toBytes32();
        cts[2] = agreement.rentalDurationDaysEncrypted.toBytes32();
        cts[3] = agreement.collateralAmountEncrypted.toBytes32();
        cts[4] = agreement.isActiveEncrypted.toBytes32();

        // 2. Compute State Hash
        bytes32 stateHash = _hashCiphertexts(cts);

        // 3. Request Decryption
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        // 4. Store Context
        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });

        lastDecryptionRequestTime[msg.sender] = block.timestamp + cooldownSeconds;
        emit DecryptionRequested(requestId, batchId);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        DecryptionContext storage ctx = decryptionContexts[requestId];

        // a. Replay Guard
        if (ctx.processed) revert ReplayError();
        // b. State Verification
        RentalAgreement storage agreement = rentalAgreements[ctx.batchId];
        bytes32[] memory currentCts = new bytes32[](5);
        currentCts[0] = agreement.assetIdEncrypted.toBytes32();
        currentCts[1] = agreement.rentalPricePerDayEncrypted.toBytes32();
        currentCts[2] = agreement.rentalDurationDaysEncrypted.toBytes32();
        currentCts[3] = agreement.collateralAmountEncrypted.toBytes32();
        currentCts[4] = agreement.isActiveEncrypted.toBytes32();

        bytes32 currentHash = _hashCiphertexts(currentCts);
        if (currentHash != ctx.stateHash) revert StateMismatchError();
        // c. Proof Verification
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) revert DecryptionFailedError();

        // d. Decode & Finalize
        uint256 assetId = abi.decode(cleartexts.slice(0, 32), (uint256));
        uint256 rentalPricePerDay = abi.decode(cleartexts.slice(32, 32), (uint256));
        uint256 rentalDurationDays = abi.decode(cleartexts.slice(64, 32), (uint256));
        uint256 collateralAmount = abi.decode(cleartexts.slice(96, 32), (uint256));
        bool isActive = abi.decode(cleartexts.slice(128, 32), (bool));

        ctx.processed = true;
        emit DecryptionCompleted(requestId, ctx.batchId, assetId, rentalPricePerDay, rentalDurationDays, collateralAmount, isActive);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 storage _e) internal {
        if (!_e.isInitialized()) {
            _e = FHE.asEuint32(0);
        }
    }

    function _requireInitialized(euint32 storage _e) internal view {
        if (!_e.isInitialized()) {
            revert NotInitializedError();
        }
    }
}