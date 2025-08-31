const { ethers } = require('ethers');
const logger = require('../utils/logger');

class SandwichBot {
  constructor(provider, wallet, config) {
    this.provider = provider;
    this.wallet = wallet;
    this.config = config;
    this.minProfitThreshold = config.minProfitThreshold || 50; // $50 minimum profit
    this.maxSlippageTarget = config.maxSlippageTarget || 0.05; // 5% max slippage to exploit
    this.isRunning = false;
  }

  async start() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    logger.info('🥪 Sandwich bot started - monitoring mempool for opportunities');
    
    // Monitor pending transactions
    this.provider.on('pending', async (txHash) => {
      try {
        await this.analyzePendingTransaction(txHash);
      } catch (error) {
        logger.error('Error analyzing pending transaction:', error);
      }
    });
  }

  async analyzePendingTransaction(txHash) {
    const tx = await this.provider.getTransaction(txHash);
    if (!tx || !tx.to) return;

    // Check if it's a DEX swap transaction
    if (this.isDEXSwap(tx)) {
      const opportunity = await this.calculateSandwichOpportunity(tx);
      
      if (opportunity.profitable) {
        await this.executeSandwichAttack(tx, opportunity);
      }
    }
  }

  isDEXSwap(tx) {
    // Common DEX router addresses
    const dexRouters = [
      '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', // Uniswap V2
      '0xE592427A0AEce92De3Edee1F18E0157C05861564', // Uniswap V3
      '0x1111111254EEB25477B68fb85Ed929f73A960582', // 1inch V4
      '0x881D40237659C251811CEC9c364ef91dC08D300C'  // Metamask Swap
    ];
    
    return dexRouters.includes(tx.to?.toLowerCase());
  }

  async calculateSandwichOpportunity(victimTx) {
    try {
      // Decode the transaction to extract swap parameters
      const swapData = await this.decodeSwapTransaction(victimTx);
      if (!swapData) return { profitable: false };

      // Calculate price impact of victim's trade
      const priceImpact = await this.calculatePriceImpact(
        swapData.tokenIn,
        swapData.tokenOut,
        swapData.amountIn,
        swapData.poolAddress
      );

      // Check if sandwich attack would be profitable
      if (priceImpact.percentage > 0.005 && priceImpact.percentage < this.maxSlippageTarget) {
        const frontrunAmount = this.calculateOptimalFrontrunAmount(swapData, priceImpact);
        const estimatedProfit = await this.estimateProfit(swapData, frontrunAmount, priceImpact);

        if (estimatedProfit > this.minProfitThreshold) {
          return {
            profitable: true,
            victimTx,
            swapData,
            frontrunAmount,
            estimatedProfit,
            priceImpact: priceImpact.percentage
          };
        }
      }

      return { profitable: false };
    } catch (error) {
      logger.error('Error calculating sandwich opportunity:', error);
      return { profitable: false };
    }
  }

  async executeSandwichAttack(victimTx, opportunity) {
    logger.info(`🎯 Executing sandwich attack - Estimated profit: $${opportunity.estimatedProfit}`);

    try {
      // Step 1: Front-run - Buy tokens to increase price
      const frontrunTx = await this.createFrontrunTransaction(opportunity);
      
      // Step 2: Wait for victim transaction to be mined
      const victimReceipt = await this.waitForVictimTransaction(victimTx);
      
      if (victimReceipt.status === 1) {
        // Step 3: Back-run - Sell tokens at higher price
        const backrunTx = await this.createBackrunTransaction(opportunity);
        
        const profit = await this.calculateActualProfit(frontrunTx, backrunTx);
        logger.info(`💰 Sandwich attack completed - Actual profit: $${profit}`);
        
        return { success: true, profit };
      }
    } catch (error) {
      logger.error('Sandwich attack failed:', error);
      return { success: false, error: error.message };
    }
  }

  calculateOptimalFrontrunAmount(swapData, priceImpact) {
    // Calculate optimal amount to frontrun (typically 10-50% of victim's trade)
    const maxFrontrun = swapData.amountIn * 0.5;
    const optimalAmount = Math.min(
      maxFrontrun,
      this.config.maxPositionSize || ethers.utils.parseEther('10')
    );
    
    return optimalAmount;
  }

  async estimateProfit(swapData, frontrunAmount, priceImpact) {
    // Simplified profit estimation
    // Real implementation would use more sophisticated calculations
    const estimatedPriceIncrease = priceImpact.percentage * 0.8; // Conservative estimate
    const estimatedProfit = frontrunAmount * estimatedPriceIncrease;
    
    // Convert to USD (simplified)
    return parseFloat(ethers.utils.formatEther(estimatedProfit)) * 2000; // Assuming ETH price
  }

  async createFrontrunTransaction(opportunity) {
    // Create transaction to buy tokens before victim
    const gasPrice = await this.getOptimalGasPrice(opportunity.victimTx);
    
    const frontrunTx = {
      to: opportunity.swapData.routerAddress,
      data: opportunity.swapData.frontrunData,
      gasLimit: 200000,
      gasPrice: gasPrice + ethers.utils.parseUnits('1', 'gwei'), // Slightly higher than victim
      value: opportunity.frontrunAmount
    };

    return await this.wallet.sendTransaction(frontrunTx);
  }

  async createBackrunTransaction(opportunity) {
    // Create transaction to sell tokens after victim
    const gasPrice = await this.getOptimalGasPrice();
    
    const backrunTx = {
      to: opportunity.swapData.routerAddress,
      data: opportunity.swapData.backrunData,
      gasLimit: 200000,
      gasPrice: gasPrice
    };

    return await this.wallet.sendTransaction(backrunTx);
  }

  async getOptimalGasPrice(targetTx = null) {
    const currentGasPrice = await this.provider.getGasPrice();
    
    if (targetTx) {
      // Pay slightly more than target transaction to front-run
      return targetTx.gasPrice.add(ethers.utils.parseUnits('1', 'gwei'));
    }
    
    return currentGasPrice;
  }

  async waitForVictimTransaction(victimTx) {
    return new Promise((resolve) => {
      const checkTransaction = async () => {
        const receipt = await this.provider.getTransactionReceipt(victimTx.hash);
        if (receipt) {
          resolve(receipt);
        } else {
          setTimeout(checkTransaction, 1000);
        }
      };
      checkTransaction();
    });
  }

  // Additional helper methods would go here...
  async decodeSwapTransaction(tx) {
    // Implementation to decode swap transaction data
    // This would extract token addresses, amounts, etc.
    return null; // Simplified for now
  }

  async calculatePriceImpact(tokenIn, tokenOut, amountIn, poolAddress) {
    // Implementation to calculate price impact
    return { percentage: 0.01 }; // Simplified for now
  }

  async calculateActualProfit(frontrunTx, backrunTx) {
    // Calculate actual profit from the sandwich attack
    return 100; // Simplified for now
  }

  stop() {
    this.isRunning = false;
    this.provider.removeAllListeners('pending');
    logger.info('🥪 Sandwich bot stopped');
  }
}

module.exports = SandwichBot;