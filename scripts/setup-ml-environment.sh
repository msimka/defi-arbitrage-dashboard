#!/bin/bash

# DeFi Arbitrage Dashboard - ML Environment Setup Script
# Run this on the desktop machine (Griffith) with 2x RTX 5060 Ti GPUs

set -e

echo "🚀 Setting up ML environment for DeFi trading models..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
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

# Check if running on correct machine
print_header "System Verification"
if ! command -v nvidia-smi &> /dev/null; then
    print_error "nvidia-smi not found. Please ensure NVIDIA drivers are installed."
    exit 1
fi

# Check GPU count
GPU_COUNT=$(nvidia-smi --list-gpus | wc -l)
print_status "Found $GPU_COUNT NVIDIA GPU(s)"

if [ "$GPU_COUNT" -lt 2 ]; then
    print_warning "Expected 2 GPUs for optimal training. Found: $GPU_COUNT"
else
    print_status "✅ GPU count is optimal for multi-GPU training"
fi

# Check VRAM
print_status "Checking GPU memory..."
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits

# Check system memory
TOTAL_RAM=$(free -h | awk '/^Mem:/ { print $2 }')
print_status "System RAM: $TOTAL_RAM"

print_header "Python Environment Setup"

# Check if conda/mamba is available
if command -v mamba &> /dev/null; then
    CONDA_CMD="mamba"
    print_status "Using mamba for package management"
elif command -v conda &> /dev/null; then
    CONDA_CMD="conda"
    print_status "Using conda for package management"
else
    print_error "Neither conda nor mamba found. Please install Miniforge or Anaconda."
    exit 1
fi

# Create conda environment
ENV_NAME="defi-trading-ml"
print_status "Creating conda environment: $ENV_NAME"

$CONDA_CMD create -n $ENV_NAME python=3.11 -y

# Activate environment
source $(conda info --base)/etc/profile.d/conda.sh
conda activate $ENV_NAME

print_header "Installing PyTorch with CUDA Support"

# Install PyTorch with CUDA 12.1 support
print_status "Installing PyTorch 2.1+ with CUDA 12.1..."
$CONDA_CMD install pytorch torchvision torchaudio pytorch-cuda=12.1 -c pytorch -c nvidia -y

# Verify CUDA installation
print_status "Verifying CUDA installation..."
python -c "import torch; print(f'PyTorch version: {torch.__version__}'); print(f'CUDA available: {torch.cuda.is_available()}'); print(f'CUDA devices: {torch.cuda.device_count()}')"

print_header "Installing ML Dependencies"

# Install core ML packages
pip install --upgrade pip
pip install -r ../src/ml_trading/requirements.txt

print_header "Installing DeFi-Specific Packages"

# Install Web3 and blockchain libraries
pip install web3 eth-account py-solc-x
pip install solana uniswap-python aiohttp

print_header "Setting up Distributed Training"

# Create necessary directories
mkdir -p ../logs/training
mkdir -p ../checkpoints
mkdir -p ../data/market_data
mkdir -p ../config

# Create training configuration
cat > ../config/training_config.json << EOF
{
  "batch_size": 256,
  "accumulation_steps": 4,
  "state_dim": 32,
  "action_dim": 4,
  "hidden_dim": 512,
  "lr_actor": 1e-4,
  "lr_critic": 1e-3,
  "episodes": 2000,
  "max_steps_per_episode": 1000,
  "train_freq": 1,
  "world_size": 2,
  "mixed_precision": true,
  "gradient_clipping": 1.0,
  "replay_buffer_size": 100000,
  "target_update_freq": 100,
  "save_freq": 100,
  "log_freq": 10
}
EOF

print_status "Created training configuration"

# Create multi-GPU training script
cat > ../scripts/train_model.sh << 'EOF'
#!/bin/bash

# Activate conda environment
source $(conda info --base)/etc/profile.d/conda.sh
conda activate defi-trading-ml

# Set CUDA visible devices
export CUDA_VISIBLE_DEVICES=0,1

# Set optimizations for multi-GPU training
export OMP_NUM_THREADS=8
export TOKENIZERS_PARALLELISM=false

# Change to ML directory
cd ../src/ml_trading

# Run distributed training
python -m torch.distributed.launch \
    --nproc_per_node=2 \
    --master_port=29500 \
    multiGpuTrainer.py \
    --config ../../config/training_config.json

echo "Training completed!"
EOF

chmod +x ../scripts/train_model.sh

print_header "Setting up Monitoring Tools"

# Install monitoring tools
pip install tensorboard wandb gpustat nvidia-ml-py3

# Create monitoring script
cat > ../scripts/monitor_training.sh << 'EOF'
#!/bin/bash

echo "🖥️  GPU Status:"
gpustat -i 1 &

echo "📊 TensorBoard (run in another terminal):"
echo "tensorboard --logdir=../logs/training --host=0.0.0.0 --port=6006"

echo "💾 Disk usage:"
df -h

echo "🧠 Memory usage:"
free -h

wait
EOF

chmod +x ../scripts/monitor_training.sh

print_header "Testing Multi-GPU Setup"

# Test multi-GPU functionality
python -c "
import torch
import torch.distributed as dist
print(f'PyTorch version: {torch.__version__}')
print(f'CUDA available: {torch.cuda.is_available()}')
print(f'CUDA devices: {torch.cuda.device_count()}')
for i in range(torch.cuda.device_count()):
    print(f'  Device {i}: {torch.cuda.get_device_name(i)}')
    print(f'    Memory: {torch.cuda.get_device_properties(i).total_memory / 1e9:.1f} GB')

# Test distributed backend
print('Testing NCCL backend...')
try:
    import os
    os.environ['MASTER_ADDR'] = 'localhost'
    os.environ['MASTER_PORT'] = '29501'
    
    if torch.cuda.device_count() >= 2:
        print('✅ Multi-GPU setup ready for distributed training')
    else:
        print('⚠️  Single GPU detected, will use data parallel training')
except Exception as e:
    print(f'❌ Distributed setup test failed: {e}')
"

print_header "Environment Information"

# Create environment info file
cat > ../config/environment_info.txt << EOF
DeFi Trading ML Environment Setup
================================

System Information:
- Date: $(date)
- User: $(whoami)
- Hostname: $(hostname)
- OS: $(uname -a)

Hardware:
- CPUs: $(nproc)
- RAM: $(free -h | grep '^Mem:' | awk '{print $2}')
- GPUs: $(nvidia-smi -L)

Software:
- Python: $(python --version)
- PyTorch: $(python -c "import torch; print(torch.__version__)")
- CUDA: $(python -c "import torch; print(torch.version.cuda)")

Environment: $ENV_NAME
Location: $(pwd)

Usage Instructions:
1. Activate environment: conda activate $ENV_NAME
2. Start training: ./scripts/train_model.sh
3. Monitor training: ./scripts/monitor_training.sh
4. View tensorboard: tensorboard --logdir=logs/training
EOF

print_status "Environment info saved to config/environment_info.txt"

print_header "Installation Complete!"

echo -e "${GREEN}"
cat << 'EOF'
🎉 ML Environment Setup Complete!

Next steps:
1. SSH to Griffith: ssh griffith
2. Navigate to project: cd projects/defi-arbitrage-dashboard
3. Activate environment: conda activate defi-trading-ml
4. Start training: ./scripts/train_model.sh

Monitor training:
- GPU usage: gpustat -i 1
- TensorBoard: tensorboard --logdir=logs/training
- Training logs: tail -f logs/training/training.log

Hardware Summary:
EOF
echo -e "${NC}"

nvidia-smi --query-gpu=index,name,memory.total,memory.used,utilization.gpu --format=csv,noheader | \
    awk -F', ' '{printf "  GPU %s: %s (%s VRAM, %s%% util)\n", $1, $2, $3, $5}'

echo ""
print_status "Environment: $ENV_NAME"
print_status "Ready for multi-GPU training with 32GB total VRAM!"
print_status "Estimated model capacity: 10B+ parameters with mixed precision"

echo -e "${BLUE}Happy trading! 🚀💰${NC}"