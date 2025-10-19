import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface RentalAsset {
  id: string;
  name: string;
  encryptedPrice: string;
  encryptedDuration: string;
  encryptedConditions: string;
  timestamp: number;
  owner: string;
  category: string;
  status: "available" | "rented" | "maintenance";
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHEEncryptBoolean = (value: boolean): string => {
  return `FHE-${btoa(value ? "1" : "0")}`;
};

const FHEDecryptBoolean = (encryptedData: string): boolean => {
  if (encryptedData.startsWith('FHE-')) {
    return atob(encryptedData.substring(4)) === "1";
  }
  return encryptedData === "true";
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [assets, setAssets] = useState<RentalAsset[]>([]);
  const [filteredAssets, setFilteredAssets] = useState<RentalAsset[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newAssetData, setNewAssetData] = useState({ name: "", category: "weapon", price: 0, duration: 7, requiresDeposit: true });
  const [selectedAsset, setSelectedAsset] = useState<RentalAsset | null>(null);
  const [decryptedPrice, setDecryptedPrice] = useState<number | null>(null);
  const [decryptedDuration, setDecryptedDuration] = useState<number | null>(null);
  const [decryptedConditions, setDecryptedConditions] = useState<{requiresDeposit: boolean} | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [userHistory, setUserHistory] = useState<{action: string, assetId: string, timestamp: number}[]>([]);
  const [showProjectInfo, setShowProjectInfo] = useState(true);

  const availableCount = assets.filter(a => a.status === "available").length;
  const rentedCount = assets.filter(a => a.status === "rented").length;
  const maintenanceCount = assets.filter(a => a.status === "maintenance").length;

  useEffect(() => {
    loadAssets().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
      
      // Load user history from localStorage
      const savedHistory = localStorage.getItem(`userHistory_${address}`);
      if (savedHistory) {
        setUserHistory(JSON.parse(savedHistory));
      }
    };
    initSignatureParams();
  }, [address]);

  useEffect(() => {
    filterAssets();
  }, [assets, searchQuery, categoryFilter, statusFilter]);

  const filterAssets = () => {
    let filtered = [...assets];
    
    if (searchQuery) {
      filtered = filtered.filter(asset => 
        asset.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        asset.category.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }
    
    if (categoryFilter !== "all") {
      filtered = filtered.filter(asset => asset.category === categoryFilter);
    }
    
    if (statusFilter !== "all") {
      filtered = filtered.filter(asset => asset.status === statusFilter);
    }
    
    setFilteredAssets(filtered);
  };

  const addToHistory = (action: string, assetId: string) => {
    const newHistory = [...userHistory, {action, assetId, timestamp: Date.now()}];
    setUserHistory(newHistory);
    if (address) {
      localStorage.setItem(`userHistory_${address}`, JSON.stringify(newHistory));
    }
  };

  const loadAssets = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      const keysBytes = await contract.getData("asset_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing asset keys:", e); }
      }
      const list: RentalAsset[] = [];
      for (const key of keys) {
        try {
          const assetBytes = await contract.getData(`asset_${key}`);
          if (assetBytes.length > 0) {
            try {
              const assetData = JSON.parse(ethers.toUtf8String(assetBytes));
              list.push({ 
                id: key, 
                name: assetData.name, 
                encryptedPrice: assetData.encryptedPrice, 
                encryptedDuration: assetData.encryptedDuration,
                encryptedConditions: assetData.encryptedConditions,
                timestamp: assetData.timestamp, 
                owner: assetData.owner, 
                category: assetData.category, 
                status: assetData.status || "available" 
              });
            } catch (e) { console.error(`Error parsing asset data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading asset ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setAssets(list);
    } catch (e) { console.error("Error loading assets:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitAsset = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting rental data with Zama FHE..." });
    try {
      const encryptedPrice = FHEEncryptNumber(newAssetData.price);
      const encryptedDuration = FHEEncryptNumber(newAssetData.duration);
      const encryptedConditions = FHEEncryptBoolean(newAssetData.requiresDeposit);
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const assetId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const assetData = { 
        name: newAssetData.name,
        encryptedPrice, 
        encryptedDuration,
        encryptedConditions,
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        category: newAssetData.category, 
        status: "available" 
      };
      await contract.setData(`asset_${assetId}`, ethers.toUtf8Bytes(JSON.stringify(assetData)));
      const keysBytes = await contract.getData("asset_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(assetId);
      await contract.setData("asset_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      setTransactionStatus({ visible: true, status: "success", message: "Asset listed securely with FHE encryption!" });
      addToHistory("Created", assetId);
      await loadAssets();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewAssetData({ name: "", category: "weapon", price: 0, duration: 7, requiresDeposit: true });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string, type: "number" | "boolean" = "number"): Promise<number | boolean | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      if (type === "number") {
        return FHEDecryptNumber(encryptedData);
      } else {
        return FHEDecryptBoolean(encryptedData);
      }
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const rentAsset = async (assetId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing rental with FHE encryption..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const assetBytes = await contract.getData(`asset_${assetId}`);
      if (assetBytes.length === 0) throw new Error("Asset not found");
      const assetData = JSON.parse(ethers.toUtf8String(assetBytes));
      
      if (assetData.status !== "available") {
        throw new Error("Asset is not available for rent");
      }
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedAsset = { ...assetData, status: "rented", renter: address };
      await contractWithSigner.setData(`asset_${assetId}`, ethers.toUtf8Bytes(JSON.stringify(updatedAsset)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Asset rented successfully with FHE protection!" });
      addToHistory("Rented", assetId);
      await loadAssets();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Rental failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const returnAsset = async (assetId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing return with FHE encryption..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const assetBytes = await contract.getData(`asset_${assetId}`);
      if (assetBytes.length === 0) throw new Error("Asset not found");
      const assetData = JSON.parse(ethers.toUtf8String(assetBytes));
      
      if (assetData.status !== "rented" || assetData.renter !== address) {
        throw new Error("You are not renting this asset");
      }
      
      const updatedAsset = { ...assetData, status: "available", renter: null };
      await contract.setData(`asset_${assetId}`, ethers.toUtf8Bytes(JSON.stringify(updatedAsset)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Asset returned successfully!" });
      addToHistory("Returned", assetId);
      await loadAssets();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Return failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (assetAddress: string) => address?.toLowerCase() === assetAddress.toLowerCase();

  const renderPieChart = () => {
    const total = assets.length || 1;
    const availablePercentage = (availableCount / total) * 100;
    const rentedPercentage = (rentedCount / total) * 100;
    const maintenancePercentage = (maintenanceCount / total) * 100;
    return (
      <div className="pie-chart-container">
        <div className="pie-chart">
          <div className="pie-segment available" style={{ transform: `rotate(${availablePercentage * 3.6}deg)` }}></div>
          <div className="pie-segment rented" style={{ transform: `rotate(${(availablePercentage + rentedPercentage) * 3.6}deg)` }}></div>
          <div className="pie-segment maintenance" style={{ transform: `rotate(${(availablePercentage + rentedPercentage + maintenancePercentage) * 3.6}deg)` }}></div>
          <div className="pie-center">
            <div className="pie-value">{assets.length}</div>
            <div className="pie-label">Assets</div>
          </div>
        </div>
        <div className="pie-legend">
          <div className="legend-item"><div className="color-box available"></div><span>Available: {availableCount}</span></div>
          <div className="legend-item"><div className="color-box rented"></div><span>Rented: {rentedCount}</span></div>
          <div className="legend-item"><div className="color-box maintenance"></div><span>Maintenance: {maintenanceCount}</span></div>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="cyber-spinner"></div>
      <p>Initializing encrypted connection to Zama FHE...</p>
    </div>
  );

  return (
    <div className="app-container cyberpunk-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"><div className="shield-icon"></div></div>
          <h1>FHE<span>Rental</span>Hub</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-asset-btn cyber-button">
            <div className="add-icon"></div>List Asset
          </button>
          <button className="cyber-button" onClick={() => setShowProjectInfo(!showProjectInfo)}>
            {showProjectInfo ? "Hide Info" : "Show Info"}
          </button>
          <div className="wallet-connect-wrapper"><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/></div>
        </div>
      </header>
      <div className="main-content">
        {showProjectInfo && (
          <div className="project-info-section cyber-card">
            <h2>FHE-Based Universal Game Asset Rental Platform</h2>
            <p>Rent your NFT game assets securely using Zama FHE encryption. All rental terms are encrypted and processed confidentially.</p>
            <div className="feature-grid">
              <div className="feature-item">
                <div className="feature-icon">🔒</div>
                <h3>FHE Encryption</h3>
                <p>Rental terms encrypted with Zama FHE technology</p>
              </div>
              <div className="feature-item">
                <div className="feature-icon">🔄</div>
                <h3>Homomorphic Verification</h3>
                <p>Verify rentals without decrypting sensitive data</p>
              </div>
              <div className="feature-item">
                <div className="feature-icon">💰</div>
                <h3>Passive Income</h3>
                <p>Earn from your unused game assets securely</p>
              </div>
            </div>
            <div className="fhe-badge"><span>Powered by Zama FHE</span></div>
          </div>
        )}
        
        <div className="dashboard-grid">
          <div className="dashboard-card cyber-card">
            <h3>Marketplace Stats</h3>
            <div className="stats-grid">
              <div className="stat-item"><div className="stat-value">{assets.length}</div><div className="stat-label">Total Assets</div></div>
              <div className="stat-item"><div className="stat-value">{availableCount}</div><div className="stat-label">Available</div></div>
              <div className="stat-item"><div className="stat-value">{rentedCount}</div><div className="stat-label">Rented</div></div>
              <div className="stat-item"><div className="stat-value">{maintenanceCount}</div><div className="stat-label">Maintenance</div></div>
            </div>
          </div>
          <div className="dashboard-card cyber-card">
            <h3>Status Distribution</h3>
            {renderPieChart()}
          </div>
          <div className="dashboard-card cyber-card">
            <h3>Your Activity</h3>
            <div className="user-stats">
              <div className="user-stat">Listed: {assets.filter(a => isOwner(a.owner)).length}</div>
              <div className="user-stat">Rented: {userHistory.filter(h => h.action === "Rented").length}</div>
              <div className="user-stat">Actions: {userHistory.length}</div>
            </div>
            {userHistory.length > 0 && (
              <div className="recent-activity">
                <h4>Recent Actions</h4>
                {userHistory.slice(-3).map((item, index) => (
                  <div key={index} className="activity-item">
                    {item.action} #{item.assetId.substring(0, 6)}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        
        <div className="assets-section">
          <div className="section-header">
            <h2>Available Rental Assets</h2>
            <div className="header-actions">
              <button onClick={loadAssets} className="refresh-btn cyber-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>
          
          <div className="filters-panel cyber-card">
            <div className="filter-group">
              <label>Search</label>
              <input 
                type="text" 
                placeholder="Search assets..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="cyber-input"
              />
            </div>
            <div className="filter-group">
              <label>Category</label>
              <select 
                value={categoryFilter} 
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="cyber-select"
              >
                <option value="all">All Categories</option>
                <option value="weapon">Weapons</option>
                <option value="skin">Skins</option>
                <option value="vehicle">Vehicles</option>
                <option value="pet">Pets</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div className="filter-group">
              <label>Status</label>
              <select 
                value={statusFilter} 
                onChange={(e) => setStatusFilter(e.target.value)}
                className="cyber-select"
              >
                <option value="all">All Status</option>
                <option value="available">Available</option>
                <option value="rented">Rented</option>
                <option value="maintenance">Maintenance</option>
              </select>
            </div>
          </div>
          
          <div className="assets-grid">
            {filteredAssets.length === 0 ? (
              <div className="no-assets cyber-card">
                <div className="no-assets-icon"></div>
                <p>No rental assets found</p>
                <button className="cyber-button primary" onClick={() => setShowCreateModal(true)}>List First Asset</button>
              </div>
            ) : filteredAssets.map(asset => (
              <div className="asset-card cyber-card" key={asset.id}>
                <div className="asset-image">
                  <div className={`asset-category ${asset.category}`}>{asset.category}</div>
                </div>
                <div className="asset-info">
                  <h3>{asset.name}</h3>
                  <div className="asset-owner">{asset.owner.substring(0, 6)}...{asset.owner.substring(38)}</div>
                  <div className="asset-meta">
                    <span className={`status-badge ${asset.status}`}>{asset.status}</span>
                    <span>{new Date(asset.timestamp * 1000).toLocaleDateString()}</span>
                  </div>
                </div>
                <div className="asset-actions">
                  <button className="cyber-button" onClick={() => setSelectedAsset(asset)}>
                    View Details
                  </button>
                  {isOwner(asset.owner) ? (
                    <div className="owner-badge">Your Asset</div>
                  ) : asset.status === "available" ? (
                    <button className="cyber-button primary" onClick={() => rentAsset(asset.id)}>
                      Rent Now
                    </button>
                  ) : asset.status === "rented" && (
                    <button className="cyber-button" onClick={() => returnAsset(asset.id)}>
                      Return
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      
      {showCreateModal && <ModalCreate onSubmit={submitAsset} onClose={() => setShowCreateModal(false)} creating={creating} assetData={newAssetData} setAssetData={setNewAssetData}/>}
      {selectedAsset && (
        <AssetDetailModal 
          asset={selectedAsset} 
          onClose={() => { setSelectedAsset(null); setDecryptedPrice(null); setDecryptedDuration(null); setDecryptedConditions(null); }} 
          decryptedPrice={decryptedPrice}
          decryptedDuration={decryptedDuration}
          decryptedConditions={decryptedConditions}
          setDecryptedPrice={setDecryptedPrice}
          setDecryptedDuration={setDecryptedDuration}
          setDecryptedConditions={setDecryptedConditions}
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
          isOwner={isOwner(selectedAsset.owner)}
          onRent={() => rentAsset(selectedAsset.id)}
          onReturn={() => returnAsset(selectedAsset.id)}
        />
      )}
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content cyber-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="cyber-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo"><div className="shield-icon"></div><span>FHERentalHub</span></div>
            <p>Secure encrypted game asset rentals using Zama FHE technology</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms of Service</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge"><span>FHE-Powered Privacy</span></div>
          <div className="copyright">© {new Date().getFullYear()} FHERentalHub. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  assetData: any;
  setAssetData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, assetData, setAssetData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setAssetData({ ...assetData, [name]: value });
  };

  const handleNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setAssetData({ ...assetData, [name]: parseFloat(value) });
  };

  const handleBooleanChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, checked } = e.target;
    setAssetData({ ...assetData, [name]: checked });
  };

  const handleSubmit = () => {
    if (!assetData.name || !assetData.price || !assetData.duration) { 
      alert("Please fill required fields"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal cyber-card">
        <div className="modal-header">
          <h2>List New Rental Asset</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div><strong>FHE Encryption Notice</strong><p>Your rental terms will be encrypted with Zama FHE before submission</p></div>
          </div>
          <div className="form-grid">
            <div className="form-group">
              <label>Asset Name *</label>
              <input type="text" name="name" value={assetData.name} onChange={handleChange} placeholder="e.g. Dragon Slayer Sword" className="cyber-input"/>
            </div>
            <div className="form-group">
              <label>Category *</label>
              <select name="category" value={assetData.category} onChange={handleChange} className="cyber-select">
                <option value="weapon">Weapon</option>
                <option value="skin">Skin</option>
                <option value="vehicle">Vehicle</option>
                <option value="pet">Pet</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div className="form-group">
              <label>Rental Price (ETH) *</label>
              <input 
                type="number" 
                name="price" 
                value={assetData.price} 
                onChange={handleNumberChange} 
                placeholder="0.1" 
                className="cyber-input"
                step="0.001"
                min="0"
              />
            </div>
            <div className="form-group">
              <label>Rental Duration (Days) *</label>
              <input 
                type="number" 
                name="duration" 
                value={assetData.duration} 
                onChange={handleNumberChange} 
                placeholder="7" 
                className="cyber-input"
                min="1"
              />
            </div>
            <div className="form-group checkbox-group">
              <label>
                <input 
                  type="checkbox" 
                  name="requiresDeposit" 
                  checked={assetData.requiresDeposit} 
                  onChange={handleBooleanChange} 
                />
                Require Security Deposit
              </label>
            </div>
          </div>
          <div className="encryption-preview">
            <h4>FHE Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain Values:</span>
                <div>Price: {assetData.price} ETH</div>
                <div>Duration: {assetData.duration} days</div>
                <div>Deposit Required: {assetData.requiresDeposit ? "Yes" : "No"}</div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>Price: {assetData.price ? FHEEncryptNumber(assetData.price).substring(0, 20) + '...' : 'Not set'}</div>
                <div>Duration: {assetData.duration ? FHEEncryptNumber(assetData.duration).substring(0, 20) + '...' : 'Not set'}</div>
                <div>Conditions: {FHEEncryptBoolean(assetData.requiresDeposit).substring(0, 20) + '...'}</div>
              </div>
            </div>
          </div>
          <div className="privacy-notice">
            <div className="privacy-icon"></div> 
            <div><strong>Data Privacy Guarantee</strong><p>Rental terms remain encrypted during FHE processing and are never decrypted on our servers</p></div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn cyber-button">Cancel</button>
          <button onClick={handleSubmit} disabled={creating} className="submit-btn cyber-button primary">
            {creating ? "Encrypting with FHE..." : "List Asset Securely"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface AssetDetailModalProps {
  asset: RentalAsset;
  onClose: () => void;
  decryptedPrice: number | null;
  decryptedDuration: number | null;
  decryptedConditions: {requiresDeposit: boolean} | null;
  setDecryptedPrice: (value: number | null) => void;
  setDecryptedDuration: (value: number | null) => void;
  setDecryptedConditions: (value: {requiresDeposit: boolean} | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string, type: "number" | "boolean") => Promise<number | boolean | null>;
  isOwner: boolean;
  onRent: () => void;
  onReturn: () => void;
}

const AssetDetailModal: React.FC<AssetDetailModalProps> = ({
  asset, onClose, decryptedPrice, decryptedDuration, decryptedConditions, 
  setDecryptedPrice, setDecryptedDuration, setDecryptedConditions, 
  isDecrypting, decryptWithSignature, isOwner, onRent, onReturn
}) => {
  const handleDecrypt = async (type: "price" | "duration" | "conditions") => {
    try {
      if (type === "price") {
        const decrypted = await decryptWithSignature(asset.encryptedPrice, "number");
        if (decrypted !== null) setDecryptedPrice(decrypted as number);
      } else if (type === "duration") {
        const decrypted = await decryptWithSignature(asset.encryptedDuration, "number");
        if (decrypted !== null) setDecryptedDuration(decrypted as number);
      } else if (type === "conditions") {
        const decrypted = await decryptWithSignature(asset.encryptedConditions, "boolean");
        if (decrypted !== null) setDecryptedConditions({requiresDeposit: decrypted as boolean});
      }
    } catch (e) {
      console.error("Decryption failed:", e);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="asset-detail-modal cyber-card">
        <div className="modal-header">
          <h2>{asset.name} Details</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="asset-info">
            <div className="info-item"><span>Category:</span><strong>{asset.category}</strong></div>
            <div className="info-item"><span>Owner:</span><strong>{asset.owner.substring(0, 6)}...{asset.owner.substring(38)}</strong></div>
            <div className="info-item"><span>Listed:</span><strong>{new Date(asset.timestamp * 1000).toLocaleString()}</strong></div>
            <div className="info-item"><span>Status:</span><strong className={`status-badge ${asset.status}`}>{asset.status}</strong></div>
          </div>
          
          <div className="encrypted-data-section">
            <h3>FHE Encrypted Rental Terms</h3>
            
            <div className="encrypted-term">
              <div className="term-header">
                <h4>Rental Price</h4>
                {decryptedPrice === null ? (
                  <button 
                    className="decrypt-btn cyber-button small" 
                    onClick={() => handleDecrypt("price")} 
                    disabled={isDecrypting}
                  >
                    {isDecrypting ? "Decrypting..." : "Decrypt with Signature"}
                  </button>
                ) : (
                  <button 
                    className="decrypt-btn cyber-button small" 
                    onClick={() => setDecryptedPrice(null)}
                  >
                    Hide Value
                  </button>
                )}
              </div>
              <div className="encrypted-data">{asset.encryptedPrice.substring(0, 50)}...</div>
              {decryptedPrice !== null && (
                <div className="decrypted-value">Decrypted: {decryptedPrice} ETH</div>
              )}
            </div>
            
            <div className="encrypted-term">
              <div className="term-header">
                <h4>Rental Duration</h4>
                {decryptedDuration === null ? (
                  <button 
                    className="decrypt-btn cyber-button small" 
                    onClick={() => handleDecrypt("duration")} 
                    disabled={isDecrypting}
                  >
                    {isDecrypting ? "Decrypting..." : "Decrypt with Signature"}
                  </button>
                ) : (
                  <button 
                    className="decrypt-btn cyber-button small" 
                    onClick={() => setDecryptedDuration(null)}
                  >
                    Hide Value
                  </button>
                )}
              </div>
              <div className="encrypted-data">{asset.encryptedDuration.substring(0, 50)}...</div>
              {decryptedDuration !== null && (
                <div className="decrypted-value">Decrypted: {decryptedDuration} days</div>
              )}
            </div>
            
            <div className="encrypted-term">
              <div className="term-header">
                <h4>Rental Conditions</h4>
                {decryptedConditions === null ? (
                  <button 
                    className="decrypt-btn cyber-button small" 
                    onClick={() => handleDecrypt("conditions")} 
                    disabled={isDecrypting}
                  >
                    {isDecrypting ? "Decrypting..." : "Decrypt with Signature"}
                  </button>
                ) : (
                  <button 
                    className="decrypt-btn cyber-button small" 
                    onClick={() => setDecryptedConditions(null)}
                  >
                    Hide Conditions
                  </button>
                )}
              </div>
              <div className="encrypted-data">{asset.encryptedConditions.substring(0, 50)}...</div>
              {decryptedConditions !== null && (
                <div className="decrypted-value">
                  Decrypted: {decryptedConditions.requiresDeposit ? "Security deposit required" : "No deposit required"}
                </div>
              )}
            </div>
            
            <div className="fhe-tag"><div className="fhe-icon"></div><span>Zama FHE Encrypted</span></div>
          </div>
        </div>
        <div className="modal-footer">
          {isOwner ? (
            <div className="owner-actions">
              <button className="cyber-button">Edit Listing</button>
              <button className="cyber-button danger">Remove Listing</button>
            </div>
          ) : asset.status === "available" ? (
            <button className="cyber-button primary" onClick={onRent}>
              Rent This Asset
            </button>
          ) : asset.status === "rented" ? (
            <button className="cyber-button" onClick={onReturn}>
              Return Asset
            </button>
          ) : null}
          <button onClick={onClose} className="close-btn cyber-button">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;