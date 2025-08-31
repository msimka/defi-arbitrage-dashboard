const axios = require('axios');
const WebSocket = require('ws');
const logger = require('../utils/logger');

class TokenDiscoveryEngine {
  constructor(config) {
    this.config = config;
    this.discoveredTokens = new Map();
    this.subscriptions = new Set();
    this.dexScreenerWs = null;
    this.pumpFunWs = null;
  }

  async initialize() {
    logger.info('🔍 Initializing Token Discovery Engine');
    
    // Connect to multiple data sources
    await this.connectToDEXScreener();
    await this.connectToPumpFun();
    await this.setupJupiterMonitoring();
    
    // Start periodic scans
    this.startPeriodicScans();
    
    logger.info('✅ Token Discovery Engine initialized');
  }

  async connectToDEXScreener() {
    try {
      // DEXScreener WebSocket for new pairs
      this.dexScreenerWs = new WebSocket('wss://io.dexscreener.com/dex/screener/pairs/h24/1?rankBy[volume][order]=desc&rankBy[priceChange][order]=desc');
      
      this.dexScreenerWs.on('open', () => {
        logger.info('📡 Connected to DEXScreener WebSocket');
      });

      this.dexScreenerWs.on('message', (data) => {
        try {
          const pairs = JSON.parse(data);
          this.processDEXScreenerData(pairs);
        } catch (error) {
          logger.error('Error processing DEXScreener data:', error);
        }
      });

      this.dexScreenerWs.on('error', (error) => {
        logger.error('DEXScreener WebSocket error:', error);
      });
    } catch (error) {
      logger.error('Failed to connect to DEXScreener:', error);
    }
  }

  async connectToPumpFun() {
    try {
      // Pump.fun API polling for new tokens
      setInterval(async () => {
        try {
          const response = await axios.get('https://frontend-api.pump.fun/coins?offset=0&limit=50&sort=created_timestamp&order=DESC');
          this.processPumpFunData(response.data);
        } catch (error) {
          logger.error('Error fetching Pump.fun data:', error);
        }
      }, 5000); // Poll every 5 seconds
      
      logger.info('📡 Connected to Pump.fun API');
    } catch (error) {
      logger.error('Failed to setup Pump.fun monitoring:', error);
    }
  }

  async setupJupiterMonitoring() {
    try {
      // Monitor Jupiter for new trading pairs
      setInterval(async () => {
        try {
          const response = await axios.get('https://price.jup.ag/v4/price?ids=SOL&vsToken=USDC');
          // This is a simplified example - Jupiter doesn't have a direct "new tokens" endpoint
          // In practice, you'd monitor transaction logs or use other methods
          logger.debug('Jupiter price check completed');
        } catch (error) {
          logger.error('Error checking Jupiter:', error);
        }
      }, 10000);
      
      logger.info('📡 Jupiter monitoring setup complete');
    } catch (error) {
      logger.error('Failed to setup Jupiter monitoring:', error);
    }
  }

  processDEXScreenerData(pairs) {
    if (!pairs || !Array.isArray(pairs)) return;

    pairs.forEach(pair => {
      if (this.isInterestingToken(pair)) {
        const tokenInfo = this.extractTokenInfo(pair);
        this.addDiscoveredToken(tokenInfo);
      }
    });
  }

  processPumpFunData(tokens) {
    if (!tokens || !Array.isArray(tokens)) return;

    tokens.forEach(token => {
      if (this.isPumpFunGem(token)) {
        const tokenInfo = {
          address: token.mint,
          symbol: token.symbol,
          name: token.name,
          platform: 'pump.fun',
          marketCap: token.usd_market_cap,
          volume24h: token.volume_24h,
          priceChange24h: null,
          liquidity: null,
          age: Date.now() - new Date(token.created_timestamp).getTime(),
          source: 'pump.fun',
          risk: this.calculateRiskScore(token, 'pump.fun'),
          potentialScore: this.calculatePotentialScore(token, 'pump.fun')
        };
        
        this.addDiscoveredToken(tokenInfo);
      }
    });
  }

  isInterestingToken(pair) {
    // Criteria for interesting tokens
    const criteria = {
      minVolume24h: 10000, // $10k minimum volume
      maxMarketCap: 10000000, // $10M maximum market cap (low cap focus)
      minLiquidity: 5000, // $5k minimum liquidity
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days old maximum
      minPriceChange: 0.1, // 10% minimum price change
    };

    return (
      pair.volume?.h24 >= criteria.minVolume24h &&
      pair.fdv <= criteria.maxMarketCap &&
      pair.liquidity?.usd >= criteria.minLiquidity &&
      Math.abs(pair.priceChange?.h24) >= criteria.minPriceChange
    );
  }

  isPumpFunGem(token) {
    // Criteria for Pump.fun gems
    return (
      token.usd_market_cap < 1000000 && // Under $1M market cap
      token.usd_market_cap > 10000 && // Over $10k market cap
      token.volume_24h > 1000 && // Some volume
      !token.is_banned &&
      token.complete === false // Not bonding curve completed yet
    );
  }

  extractTokenInfo(pair) {
    return {
      address: pair.baseToken.address,
      symbol: pair.baseToken.symbol,
      name: pair.baseToken.name,
      platform: pair.dexId,
      marketCap: pair.fdv,
      volume24h: pair.volume?.h24,
      priceChange24h: pair.priceChange?.h24,
      liquidity: pair.liquidity?.usd,
      age: pair.pairCreatedAt ? Date.now() - new Date(pair.pairCreatedAt).getTime() : null,
      source: 'dexscreener',
      risk: this.calculateRiskScore(pair, 'dexscreener'),
      potentialScore: this.calculatePotentialScore(pair, 'dexscreener')
    };
  }

  calculateRiskScore(tokenData, source) {
    let riskScore = 0;
    
    if (source === 'dexscreener') {
      // Low liquidity = higher risk
      if (tokenData.liquidity?.usd < 50000) riskScore += 30;
      
      // High volatility = higher risk
      if (Math.abs(tokenData.priceChange?.h24) > 50) riskScore += 20;
      
      // Very new token = higher risk
      const age = tokenData.pairCreatedAt ? Date.now() - new Date(tokenData.pairCreatedAt).getTime() : 0;
      if (age < 24 * 60 * 60 * 1000) riskScore += 25; // Less than 1 day
      
      // Low volume = higher risk
      if (tokenData.volume?.h24 < 50000) riskScore += 15;
      
    } else if (source === 'pump.fun') {
      // Pump.fun tokens are inherently risky
      riskScore = 70;
      
      // If bonding curve is close to completion, less risky
      if (tokenData.progress && tokenData.progress > 80) riskScore -= 15;
      
      // If has significant volume, slightly less risky
      if (tokenData.volume_24h > 10000) riskScore -= 10;
    }
    
    return Math.min(Math.max(riskScore, 0), 100);
  }

  calculatePotentialScore(tokenData, source) {
    let potentialScore = 0;
    
    if (source === 'dexscreener') {
      // High volume = higher potential
      if (tokenData.volume?.h24 > 100000) potentialScore += 25;
      
      // Positive price trend = higher potential
      if (tokenData.priceChange?.h24 > 20) potentialScore += 20;
      
      // Good liquidity but not too high (room to grow) = higher potential
      if (tokenData.liquidity?.usd > 50000 && tokenData.liquidity?.usd < 500000) potentialScore += 20;
      
      // Small market cap = higher potential
      if (tokenData.fdv < 1000000) potentialScore += 15;
      
    } else if (source === 'pump.fun') {
      // Base potential for pump.fun tokens
      potentialScore = 40;
      
      // High volume = higher potential
      if (tokenData.volume_24h > 5000) potentialScore += 20;
      
      // Good progress on bonding curve = higher potential
      if (tokenData.progress && tokenData.progress > 50 && tokenData.progress < 90) potentialScore += 20;
    }
    
    return Math.min(Math.max(potentialScore, 0), 100);
  }

  addDiscoveredToken(tokenInfo) {
    const key = `${tokenInfo.address}_${tokenInfo.platform}`;
    
    if (!this.discoveredTokens.has(key)) {
      this.discoveredTokens.set(key, {
        ...tokenInfo,
        discoveredAt: Date.now(),
        alerts: []
      });
      
      logger.info(`🆕 New token discovered: ${tokenInfo.symbol} (${tokenInfo.platform}) - Risk: ${tokenInfo.risk}% - Potential: ${tokenInfo.potentialScore}%`);
      
      // Emit event for real-time dashboard updates
      if (this.onTokenDiscovered) {
        this.onTokenDiscovered(tokenInfo);
      }
      
      // Check if it meets criteria for immediate alerts
      if (this.shouldAlert(tokenInfo)) {
        this.sendAlert(tokenInfo);
      }
    }
  }

  shouldAlert(tokenInfo) {
    return (
      tokenInfo.potentialScore > 70 ||
      (tokenInfo.potentialScore > 50 && tokenInfo.risk < 60) ||
      (tokenInfo.volume24h > 100000 && tokenInfo.marketCap < 500000)
    );
  }

  sendAlert(tokenInfo) {
    const alertMessage = `🚨 HIGH POTENTIAL TOKEN ALERT 🚨
    Symbol: ${tokenInfo.symbol}
    Platform: ${tokenInfo.platform}
    Market Cap: $${tokenInfo.marketCap?.toLocaleString() || 'N/A'}
    24h Volume: $${tokenInfo.volume24h?.toLocaleString() || 'N/A'}
    Risk Score: ${tokenInfo.risk}%
    Potential Score: ${tokenInfo.potentialScore}%
    Address: ${tokenInfo.address}`;
    
    logger.warn(alertMessage);
    
    // Here you would send to Telegram, Discord, email, etc.
    if (this.onAlert) {
      this.onAlert(tokenInfo, alertMessage);
    }
  }

  startPeriodicScans() {
    // Scan for trending tokens every minute
    setInterval(() => {
      this.scanTrendingTokens();
    }, 60000);
    
    // Clean up old tokens every hour
    setInterval(() => {
      this.cleanupOldTokens();
    }, 3600000);
  }

  async scanTrendingTokens() {
    try {
      // Check CoinGecko trending
      const response = await axios.get('https://api.coingecko.com/api/v3/search/trending');
      const trending = response.data.coins;
      
      trending.forEach(coin => {
        // Process trending coins that might be low market cap
        if (coin.item.market_cap_rank > 500) {
          logger.info(`📈 Trending low-cap coin: ${coin.item.symbol}`);
        }
      });
    } catch (error) {
      logger.error('Error scanning trending tokens:', error);
    }
  }

  cleanupOldTokens() {
    const now = Date.now();
    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
    
    let cleaned = 0;
    for (const [key, token] of this.discoveredTokens) {
      if (now - token.discoveredAt > maxAge) {
        this.discoveredTokens.delete(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      logger.info(`🧹 Cleaned up ${cleaned} old tokens`);
    }
  }

  getDiscoveredTokens(filters = {}) {
    const tokens = Array.from(this.discoveredTokens.values());
    
    return tokens.filter(token => {
      if (filters.minPotential && token.potentialScore < filters.minPotential) return false;
      if (filters.maxRisk && token.risk > filters.maxRisk) return false;
      if (filters.platform && token.platform !== filters.platform) return false;
      if (filters.maxAge && (Date.now() - token.discoveredAt) > filters.maxAge) return false;
      
      return true;
    }).sort((a, b) => b.potentialScore - a.potentialScore);
  }

  onTokenDiscovered(callback) {
    this.onTokenDiscovered = callback;
  }

  onAlert(callback) {
    this.onAlert = callback;
  }

  stop() {
    if (this.dexScreenerWs) {
      this.dexScreenerWs.close();
    }
    logger.info('🔍 Token Discovery Engine stopped');
  }
}

module.exports = TokenDiscoveryEngine;