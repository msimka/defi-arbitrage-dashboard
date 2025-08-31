const { Connection, PublicKey, Keypair, Transaction } = require('@solana/web3.js');
const { Jupiter } = require('@jup-ag/core');
const axios = require('axios');
const logger = require('../utils/logger');

class SolanaSniper {
  constructor(config) {
    this.connection = new Connection(config.rpcUrl || 'https://api.mainnet-beta.solana.com');
    this.wallet = Keypair.fromSecretKey(Buffer.from(config.privateKey, 'base64'));
    this.jupiter = null;
    this.config = {
      maxSlippage: config.maxSlippage || 0.05, // 5%
      minLiquidity: config.minLiquidity || 10000, // $10k
      maxBuyAmount: config.maxBuyAmount || 1, // 1 SOL max
      gasMultiplier: config.gasMultiplier || 1.5,
      ...config
    };
    this.isRunning = false;
    this.monitoredTokens = new Set();
  }

  async initialize() {
    try {
      logger.info('🎯 Initializing Solana Sniper Bot');
      
      // Initialize Jupiter SDK
      this.jupiter = await Jupiter.load({
        connection: this.connection,
        cluster: 'mainnet-beta',
        user: this.wallet,
        wrapUnwrapSOL: true
      });

      // Start monitoring new token listings
      await this.startTokenMonitoring();
      
      logger.info('✅ Solana Sniper Bot initialized');
    } catch (error) {
      logger.error('Failed to initialize Solana Sniper:', error);
      throw error;
    }
  }

  async startTokenMonitoring() {
    this.isRunning = true;
    
    // Monitor Pump.fun for new launches
    this.monitorPumpFun();
    
    // Monitor Raydium for new pools
    this.monitorRaydium();
    
    // Monitor Jupiter for new routes
    this.monitorJupiter();
  }

  async monitorPumpFun() {
    setInterval(async () => {
      try {
        const response = await axios.get('https://frontend-api.pump.fun/coins?offset=0&limit=20&sort=created_timestamp&order=DESC');
        
        if (response.data && Array.isArray(response.data)) {
          for (const token of response.data) {
            if (this.shouldSnipeToken(token, 'pump.fun')) {
              await this.executeSnipe(token, 'pump.fun');
            }
          }
        }
      } catch (error) {
        logger.error('Error monitoring Pump.fun:', error);
      }
    }, 3000); // Check every 3 seconds
  }

  async monitorRaydium() {
    // Monitor Raydium program logs for new pool creation
    this.connection.onLogs(
      new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'), // Raydium AMM program
      (logs) => {
        this.processRaydiumLogs(logs);
      },
      'confirmed'
    );
  }

  async monitorJupiter() {
    // Check for new token routes periodically
    setInterval(async () => {
      try {
        // Get all tokens from Jupiter
        const response = await axios.get('https://token.jup.ag/all');
        const tokens = response.data;
        
        // Check for new tokens (simplified check)
        tokens.forEach(token => {
          if (!this.monitoredTokens.has(token.address)) {
            this.monitoredTokens.add(token.address);
            if (this.shouldSnipeToken(token, 'jupiter')) {
              this.executeSnipe(token, 'jupiter');
            }
          }
        });
      } catch (error) {
        logger.error('Error monitoring Jupiter:', error);
      }
    }, 10000); // Check every 10 seconds
  }

  shouldSnipeToken(token, platform) {
    try {
      if (platform === 'pump.fun') {
        return (
          token.usd_market_cap < 100000 && // Under $100k market cap
          token.usd_market_cap > 5000 && // Over $5k market cap
          !token.is_banned &&
          token.complete === false && // Bonding curve not completed
          token.volume_24h > 100 && // Some trading volume
          !token.nsfw &&
          this.passesSecurityCheck(token)
        );
      } else if (platform === 'jupiter') {
        return (
          token.verified === false && // Unverified tokens (new)
          this.passesSecurityCheck(token)
        );
      }
      
      return false;
    } catch (error) {
      logger.error('Error evaluating token for sniping:', error);
      return false;
    }
  }

  passesSecurityCheck(token) {
    // Basic security checks
    const suspiciousNames = ['test', 'scam', 'fake', 'copy', 'clone'];
    const tokenName = (token.name || '').toLowerCase();
    const tokenSymbol = (token.symbol || '').toLowerCase();
    
    // Check for suspicious names
    for (const suspicious of suspiciousNames) {
      if (tokenName.includes(suspicious) || tokenSymbol.includes(suspicious)) {
        return false;
      }
    }
    
    // Check for reasonable symbol length
    if (tokenSymbol.length > 10 || tokenSymbol.length < 2) {
      return false;
    }
    
    return true;
  }

  async executeSnipe(token, platform) {
    const tokenKey = `${token.mint || token.address}_${platform}`;
    
    // Prevent duplicate snipes
    if (this.monitoredTokens.has(tokenKey)) return;
    this.monitoredTokens.add(tokenKey);

    try {
      logger.info(`🎯 Attempting to snipe: ${token.symbol} on ${platform}`);
      
      const tokenMint = token.mint || token.address;
      const buyAmount = this.calculateBuyAmount(token);
      
      // Get quote from Jupiter
      const routes = await this.jupiter.computeRoutes({
        inputMint: new PublicKey('So11111111111111111111111111111111111111112'), // SOL
        outputMint: new PublicKey(tokenMint),
        amount: buyAmount,
        slippageBps: Math.floor(this.config.maxSlippage * 10000), // Convert to basis points
        forceFetch: true
      });

      if (routes.routesInfos.length === 0) {
        logger.warn(`No routes found for ${token.symbol}`);
        return;
      }

      const bestRoute = routes.routesInfos[0];
      
      // Check if the route is profitable/reasonable
      if (!this.validateRoute(bestRoute, token)) {
        logger.warn(`Route validation failed for ${token.symbol}`);
        return;
      }

      // Execute the swap with high priority
      const { execute } = await this.jupiter.exchange({
        routeInfo: bestRoute,
        userPublicKey: this.wallet.publicKey
      });

      const swapResult = await execute({
        wallet: {
          signTransaction: async (tx) => {
            tx.partialSign(this.wallet);
            return tx;
          },
          signAllTransactions: async (txs) => {
            return txs.map(tx => {
              tx.partialSign(this.wallet);
              return tx;
            });
          },
          publicKey: this.wallet.publicKey
        }
      });

      if (swapResult.txid) {
        logger.info(`✅ Successfully sniped ${token.symbol} - TX: ${swapResult.txid}`);
        
        // Set up automatic sell conditions
        await this.setupAutoSell(tokenMint, token);
        
      } else {
        logger.error(`❌ Failed to snipe ${token.symbol}`);
      }

    } catch (error) {
      logger.error(`Error sniping ${token.symbol}:`, error);
    }
  }

  calculateBuyAmount(token) {
    // Calculate buy amount based on token characteristics
    let baseAmount = 0.1; // 0.1 SOL base
    
    // Adjust based on market cap
    if (token.usd_market_cap && token.usd_market_cap < 20000) {
      baseAmount = 0.05; // Smaller position for very small market cap
    } else if (token.usd_market_cap && token.usd_market_cap > 50000) {
      baseAmount = 0.2; // Larger position for higher market cap
    }
    
    return Math.min(baseAmount * 1000000000, this.config.maxBuyAmount * 1000000000); // Convert to lamports
  }

  validateRoute(route, token) {
    try {
      // Check slippage
      if (route.marketInfos.some(market => market.amm?.label === 'Unknown')) {
        return false; // Avoid unknown AMMs
      }
      
      // Check for reasonable price impact
      const priceImpactPct = route.priceImpactPct;
      if (priceImpactPct > this.config.maxSlippage * 100) {
        logger.warn(`Price impact too high: ${priceImpactPct}% for ${token.symbol}`);
        return false;
      }
      
      return true;
    } catch (error) {
      logger.error('Error validating route:', error);
      return false;
    }
  }

  async setupAutoSell(tokenMint, tokenInfo) {
    // Set up automatic sell conditions
    const sellConditions = {
      profitTarget: 2.0, // 100% profit target
      stopLoss: 0.5, // 50% stop loss
      timeLimit: 60 * 60 * 1000, // 1 hour time limit
      trailingStop: 0.8 // Trailing stop at 20% from peak
    };

    logger.info(`⚙️ Setting up auto-sell for ${tokenInfo.symbol} - Profit target: ${sellConditions.profitTarget * 100}%`);
    
    // Monitor price and execute sells based on conditions
    this.monitorForSell(tokenMint, tokenInfo, sellConditions);
  }

  async monitorForSell(tokenMint, tokenInfo, conditions) {
    const startTime = Date.now();
    let highestValue = 0;
    let initialPrice = null;

    const checkInterval = setInterval(async () => {
      try {
        // Check if time limit exceeded
        if (Date.now() - startTime > conditions.timeLimit) {
          await this.executeSell(tokenMint, tokenInfo, 'Time limit reached');
          clearInterval(checkInterval);
          return;
        }

        // Get current token balance and price
        const balance = await this.getTokenBalance(tokenMint);
        if (balance === 0) {
          clearInterval(checkInterval);
          return;
        }

        const currentPrice = await this.getTokenPrice(tokenMint);
        if (!currentPrice) return;

        if (!initialPrice) initialPrice = currentPrice;

        const currentValue = balance * currentPrice;
        const profitMultiplier = currentPrice / initialPrice;

        // Update highest value for trailing stop
        if (currentValue > highestValue) {
          highestValue = currentValue;
        }

        // Check profit target
        if (profitMultiplier >= conditions.profitTarget) {
          await this.executeSell(tokenMint, tokenInfo, `Profit target reached: ${(profitMultiplier * 100).toFixed(2)}%`);
          clearInterval(checkInterval);
          return;
        }

        // Check stop loss
        if (profitMultiplier <= conditions.stopLoss) {
          await this.executeSell(tokenMint, tokenInfo, `Stop loss triggered: ${(profitMultiplier * 100).toFixed(2)}%`);
          clearInterval(checkInterval);
          return;
        }

        // Check trailing stop
        if (currentValue < (highestValue * conditions.trailingStop)) {
          await this.executeSell(tokenMint, tokenInfo, `Trailing stop triggered: ${((currentValue / highestValue) * 100).toFixed(2)}% from peak`);
          clearInterval(checkInterval);
          return;
        }

      } catch (error) {
        logger.error('Error monitoring for sell:', error);
      }
    }, 5000); // Check every 5 seconds
  }

  async executeSell(tokenMint, tokenInfo, reason) {
    try {
      logger.info(`💰 Executing sell for ${tokenInfo.symbol} - Reason: ${reason}`);

      const balance = await this.getTokenBalance(tokenMint);
      if (balance === 0) return;

      // Get sell route
      const routes = await this.jupiter.computeRoutes({
        inputMint: new PublicKey(tokenMint),
        outputMint: new PublicKey('So11111111111111111111111111111111111111112'), // SOL
        amount: balance,
        slippageBps: Math.floor(this.config.maxSlippage * 10000),
        forceFetch: true
      });

      if (routes.routesInfos.length === 0) {
        logger.error(`No sell routes found for ${tokenInfo.symbol}`);
        return;
      }

      const bestRoute = routes.routesInfos[0];
      const { execute } = await this.jupiter.exchange({
        routeInfo: bestRoute,
        userPublicKey: this.wallet.publicKey
      });

      const swapResult = await execute({
        wallet: {
          signTransaction: async (tx) => {
            tx.partialSign(this.wallet);
            return tx;
          },
          signAllTransactions: async (txs) => {
            return txs.map(tx => {
              tx.partialSign(this.wallet);
              return tx;
            });
          },
          publicKey: this.wallet.publicKey
        }
      });

      if (swapResult.txid) {
        logger.info(`✅ Successfully sold ${tokenInfo.symbol} - TX: ${swapResult.txid}`);
      }

    } catch (error) {
      logger.error(`Error selling ${tokenInfo.symbol}:`, error);
    }
  }

  async getTokenBalance(tokenMint) {
    try {
      const tokenAccounts = await this.connection.getTokenAccountsByOwner(
        this.wallet.publicKey,
        { mint: new PublicKey(tokenMint) }
      );

      if (tokenAccounts.value.length === 0) return 0;

      const balance = await this.connection.getTokenAccountBalance(
        tokenAccounts.value[0].pubkey
      );

      return balance.value.uiAmount || 0;
    } catch (error) {
      logger.error('Error getting token balance:', error);
      return 0;
    }
  }

  async getTokenPrice(tokenMint) {
    try {
      const response = await axios.get(`https://price.jup.ag/v4/price?ids=${tokenMint}&vsToken=So11111111111111111111111111111111111111112`);
      return response.data.data[tokenMint]?.price || null;
    } catch (error) {
      logger.error('Error getting token price:', error);
      return null;
    }
  }

  processRaydiumLogs(logs) {
    // Process Raydium logs for new pool creation
    // This is a simplified version - real implementation would decode the logs properly
    logger.debug('Raydium logs received:', logs.signature);
  }

  stop() {
    this.isRunning = false;
    logger.info('🎯 Solana Sniper Bot stopped');
  }
}

module.exports = SolanaSniper;