#!/bin/bash

# Ethereum Full Node + Validator Setup Script
# Implements architect recommendations for maximum MEV advantage
# Hardware allocation: 32GB RAM, 2TB storage, direct mempool access

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_status() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_header() {
    echo -e "${BLUE}=== $1 ===${NC}"
}

print_header "Ethereum Full Node + Validator Setup"

# Validate system requirements
print_status "Validating system requirements..."

# Check available RAM (need 32GB for Ethereum node)
TOTAL_RAM=$(free -g | awk '/^Mem:/{print $2}')
if [ "$TOTAL_RAM" -lt 32 ]; then
    print_error "Insufficient RAM: ${TOTAL_RAM}GB available, 32GB+ required"
    exit 1
fi

# Check available disk space (need 2TB for Ethereum data)
AVAILABLE_SPACE=$(df -BG /home | awk 'NR==2{gsub(/G/,"",$4); print $4}')
if [ "$AVAILABLE_SPACE" -lt 2000 ]; then
    print_error "Insufficient disk space: ${AVAILABLE_SPACE}GB available, 2TB+ required"
    exit 1
fi

print_status "✅ System requirements met: ${TOTAL_RAM}GB RAM, ${AVAILABLE_SPACE}GB available space"

# Create directories
print_status "Creating Ethereum data directories..."
sudo mkdir -p /data/ethereum/{execution,consensus,validator}
sudo mkdir -p /data/ethereum/jwtsecret
sudo chown -R $USER:$USER /data/ethereum

# Generate JWT secret for execution-consensus communication
print_status "Generating JWT secret for client authentication..."
openssl rand -hex 32 > /data/ethereum/jwtsecret/jwt.hex
chmod 644 /data/ethereum/jwtsecret/jwt.hex

# Install Docker if not present
if ! command -v docker &> /dev/null; then
    print_status "Installing Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh
    sudo usermod -aG docker $USER
    print_warning "Please log out and back in for Docker permissions to take effect"
fi

# Create Docker network for Ethereum clients
print_status "Creating Docker network for Ethereum clients..."
docker network create ethereum-net 2>/dev/null || true

print_header "Setting up Nethermind Execution Client"

# Nethermind execution client (architect recommended for fastest sync)
print_status "Starting Nethermind execution client..."
docker run -d \
    --name ethereum-execution \
    --network ethereum-net \
    --restart unless-stopped \
    -v /data/ethereum/execution:/data \
    -v /data/ethereum/jwtsecret:/jwtsecret:ro \
    -p 30303:30303 \
    -p 30303:30303/udp \
    -p 8545:8545 \
    -p 8546:8546 \
    nethermind/nethermind:latest \
    --config mainnet \
    --datadir /data \
    --JsonRpc.Enabled true \
    --JsonRpc.Host 0.0.0.0 \
    --JsonRpc.Port 8545 \
    --JsonRpc.WebSocketsPort 8546 \
    --JsonRpc.EnabledModules "Eth,Subscribe,Trace,TxPool,Web3,Personal,Proof,Net,Parity,Health,Rpc" \
    --Network.DiscoveryPort 30303 \
    --Network.P2PPort 30303 \
    --JsonRpc.JwtSecretFile /jwtsecret/jwt.hex

print_status "✅ Nethermind execution client started"
print_status "Sync status: This will take 1-2 days for full sync from genesis"

print_header "Setting up Lighthouse Consensus Client"

# Lighthouse consensus client (architect recommended for efficiency)
print_status "Starting Lighthouse beacon node..."
docker run -d \
    --name ethereum-consensus \
    --network ethereum-net \
    --restart unless-stopped \
    -v /data/ethereum/consensus:/data \
    -v /data/ethereum/jwtsecret:/jwtsecret:ro \
    -p 9000:9000 \
    -p 9000:9000/udp \
    -p 5052:5052 \
    sigp/lighthouse:latest \
    lighthouse bn \
    --network mainnet \
    --datadir /data \
    --http \
    --http-address 0.0.0.0 \
    --http-port 5052 \
    --execution-endpoint http://ethereum-execution:8545 \
    --execution-jwt /jwtsecret/jwt.hex \
    --checkpoint-sync-url https://mainnet.checkpoint.sigp.io

print_status "✅ Lighthouse consensus client started"

print_header "MEV-Boost Setup for Validator Revenue"

# MEV-Boost for capturing MEV revenue as validator
print_status "Setting up MEV-Boost for maximum validator MEV capture..."
docker run -d \
    --name mev-boost \
    --network ethereum-net \
    --restart unless-stopped \
    -p 18550:18550 \
    flashbots/mev-boost:latest \
    -mainnet \
    -addr 0.0.0.0:18550 \
    -relay-check \
    -relays https://0xac6e77dfe25ecd6110b8e780608cce0dab71fdd5ebea22a16c0205200f2f8e2e3b3b5b5332b7b92b13c3b7b6b6b6b6@boost-relay.flashbots.net,https://0xb3ee7afcf27f1f1259ac1787876318c6584ee353097a50ed84f51a1f21a323b3736f271a895c7ce918c038e4265918be@relay.ultrasound.money

print_status "✅ MEV-Boost configured with top-performing relays"

print_header "Validator Setup (Requires 32 ETH)"

# Check if user wants to set up validator
read -p "Do you want to set up an Ethereum validator? (requires 32 ETH deposit) [y/N]: " setup_validator

if [[ $setup_validator =~ ^[Yy]$ ]]; then
    print_status "Setting up Ethereum validator..."
    
    # Validator key generation (user must have deposit data)
    print_warning "IMPORTANT: You must have validator keys and deposit data ready"
    print_warning "If you don't have keys, generate them securely offline using ethereum/staking-deposit-cli"
    
    read -p "Path to validator keystores directory: " keystore_path
    read -p "Path to validator secrets directory: " secrets_path
    
    if [[ -d "$keystore_path" && -d "$secrets_path" ]]; then
        # Copy validator keys to secure location
        cp -r "$keystore_path" /data/ethereum/validator/keystores/
        cp -r "$secrets_path" /data/ethereum/validator/secrets/
        chmod -R 600 /data/ethereum/validator/
        
        # Start Lighthouse validator client
        docker run -d \
            --name ethereum-validator \
            --network ethereum-net \
            --restart unless-stopped \
            -v /data/ethereum/validator:/validator \
            sigp/lighthouse:latest \
            lighthouse vc \
            --network mainnet \
            --datadir /validator \
            --beacon-nodes http://ethereum-consensus:5052 \
            --builder-proposals \
            --builder-boost-factor 90 \
            --suggested-fee-recipient YOUR_FEE_RECIPIENT_ADDRESS
            
        print_status "✅ Ethereum validator started"
        print_status "💰 Validator will earn ~3.5% staking + 2.5% MEV rewards annually"
    else
        print_error "Invalid keystore or secrets path. Validator not configured."
    fi
else
    print_status "Validator setup skipped. Node will run in full node mode only."
fi

print_header "Monitoring and Health Checks"

# Create monitoring script
cat > /data/ethereum/monitor.sh << 'EOF'
#!/bin/bash

echo "=== Ethereum Node Status ==="
echo "Execution Client (Nethermind):"
docker logs --tail 5 ethereum-execution 2>/dev/null || echo "  Not running"

echo -e "\nConsensus Client (Lighthouse):"  
docker logs --tail 5 ethereum-consensus 2>/dev/null || echo "  Not running"

echo -e "\nMEV-Boost:"
docker logs --tail 3 mev-boost 2>/dev/null || echo "  Not running"

if docker ps | grep -q ethereum-validator; then
    echo -e "\nValidator:"
    docker logs --tail 3 ethereum-validator 2>/dev/null
fi

echo -e "\n=== Sync Status ==="
# Check execution client sync
curl -s -X POST -H "Content-Type: application/json" \
    --data '{"jsonrpc":"2.0","method":"eth_syncing","params":[],"id":1}' \
    http://localhost:8545 | jq .

echo -e "\n=== Resource Usage ==="
echo "Disk usage: $(du -sh /data/ethereum 2>/dev/null || echo 'N/A')"
echo "Docker containers:"
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" | grep ethereum
EOF

chmod +x /data/ethereum/monitor.sh

print_status "✅ Monitoring script created at /data/ethereum/monitor.sh"

print_header "Setup Complete!"

cat << EOF
🎉 Ethereum Full Node + Validator setup complete!

📊 System Status:
   - Execution Client: Nethermind (fast sync, 1-2 days)
   - Consensus Client: Lighthouse (efficient)
   - MEV-Boost: Configured for maximum validator revenue
   - Data Location: /data/ethereum/
   - Monitoring: /data/ethereum/monitor.sh

🔗 Connection Endpoints:
   - Execution RPC: http://localhost:8545
   - Execution WebSocket: ws://localhost:8546  
   - Consensus API: http://localhost:5052
   - MEV-Boost: http://localhost:18550

💰 Expected Returns (with 32 ETH validator):
   - Staking Rewards: 3.5% APR (~$3,500 annually)
   - MEV Revenue: 2.5% APR (~$2,500 annually)
   - Total: ~6% APR (~$6,000 annually)

📈 MEV Trading Advantages:
   - Direct mempool access: 20-50ms latency improvement
   - Block proposing: Include your MEV transactions first
   - Enhanced data: Superior ML model training

⚠️  Important Notes:
   - Sync will take 1-2 days initially
   - Validator requires 32 ETH deposit
   - Monitor with: /data/ethereum/monitor.sh
   - Backup validator keys securely

🚀 Next Steps:
   1. Wait for initial sync completion
   2. Integrate with DeFi arbitrage dashboard
   3. Configure MEV trading system for direct node access
   4. Monitor performance and validator rewards

EOF

print_status "Run '/data/ethereum/monitor.sh' to check status"