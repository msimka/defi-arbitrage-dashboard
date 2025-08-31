import torch
import torch.distributed as dist
import torch.multiprocessing as mp
from torch.nn.parallel import DistributedDataParallel as DDP
from torch.utils.data.distributed import DistributedSampler
from torch.utils.data import DataLoader
import os
import logging
from typing import Dict, Any, Optional
import numpy as np
from actorCritic import DDPGAgent, DeFiTradingEnvironment

logger = logging.getLogger(__name__)

class MultiGPUTrainer:
    """Multi-GPU trainer for DeFi ML models with gradient accumulation"""
    
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.world_size = config.get('world_size', torch.cuda.device_count())
        self.rank = None
        self.local_rank = None
        self.device = None
        
        # Training hyperparameters
        self.batch_size = config.get('batch_size', 256)
        self.accumulation_steps = config.get('accumulation_steps', 4)
        self.effective_batch_size = self.batch_size * self.accumulation_steps * self.world_size
        
        # Model configuration
        self.state_dim = config.get('state_dim', 20)
        self.action_dim = config.get('action_dim', 2)
        self.hidden_dim = config.get('hidden_dim', 256)
        
        # Learning rates
        self.lr_actor = config.get('lr_actor', 1e-4)
        self.lr_critic = config.get('lr_critic', 1e-3)
        
        # Training parameters
        self.episodes = config.get('episodes', 1000)
        self.max_steps_per_episode = config.get('max_steps_per_episode', 500)
        self.train_freq = config.get('train_freq', 1)  # Train every N steps
        
        logger.info(f"MultiGPU Trainer initialized with world_size={self.world_size}")
        logger.info(f"Effective batch size: {self.effective_batch_size}")
    
    def setup_distributed(self, rank: int, world_size: int):
        """Setup distributed training environment"""
        os.environ['MASTER_ADDR'] = 'localhost'
        os.environ['MASTER_PORT'] = '12355'
        
        # Initialize process group
        dist.init_process_group("nccl", rank=rank, world_size=world_size)
        
        self.rank = rank
        self.local_rank = rank % torch.cuda.device_count()
        self.device = f'cuda:{self.local_rank}'
        
        # Set device for current process
        torch.cuda.set_device(self.local_rank)
        
        logger.info(f"Process {rank} initialized on device {self.device}")
    
    def cleanup_distributed(self):
        """Cleanup distributed training"""
        if dist.is_initialized():
            dist.destroy_process_group()
    
    def create_agent(self) -> DDPGAgent:
        """Create DDPG agent with DDP wrapper"""
        agent = DDPGAgent(
            state_dim=self.state_dim,
            action_dim=self.action_dim,
            device=self.device,
            lr_actor=self.lr_actor,
            lr_critic=self.lr_critic,
            hidden_dim=self.hidden_dim
        )
        
        # Wrap networks with DDP
        agent.actor = DDP(agent.actor, device_ids=[self.local_rank])
        agent.critic = DDP(agent.critic, device_ids=[self.local_rank])
        agent.target_actor = DDP(agent.target_actor, device_ids=[self.local_rank])
        agent.target_critic = DDP(agent.target_critic, device_ids=[self.local_rank])
        
        return agent
    
    def train_episode(self, agent: DDPGAgent, env: DeFiTradingEnvironment) -> Dict[str, float]:
        """Train agent for one episode with gradient accumulation"""
        state = env.reset()
        episode_reward = 0.0
        episode_steps = 0
        training_metrics = {
            'actor_loss': 0.0,
            'critic_loss': 0.0,
            'q_value_mean': 0.0,
            'training_updates': 0
        }
        
        for step in range(self.max_steps_per_episode):
            # Select action
            action = agent.select_action(state, add_noise=True)
            
            # Execute action
            next_state, reward, done, info = env.step(action)
            
            # Store transition
            agent.store_transition(state, action, reward, next_state, done)
            
            episode_reward += reward
            episode_steps += 1
            
            # Train agent with gradient accumulation
            if step % self.train_freq == 0 and len(agent.replay_buffer) >= self.batch_size:
                # Accumulate gradients over multiple batches
                accumulated_metrics = {'actor_loss': 0.0, 'critic_loss': 0.0, 'q_value_mean': 0.0}
                
                for acc_step in range(self.accumulation_steps):
                    # Sample batch
                    states, actions, rewards, next_states, dones = agent.replay_buffer.sample(
                        self.batch_size // self.accumulation_steps
                    )
                    
                    # Move to device
                    states = states.to(self.device)
                    actions = actions.to(self.device)
                    rewards = rewards.to(self.device)
                    next_states = next_states.to(self.device)
                    dones = dones.to(self.device)
                    
                    # Forward pass (scaled for accumulation)
                    batch_metrics = self._train_batch(
                        agent, states, actions, rewards, next_states, dones,
                        accumulation_step=acc_step,
                        total_accumulation_steps=self.accumulation_steps
                    )
                    
                    # Accumulate metrics
                    for key in accumulated_metrics:
                        if key in batch_metrics:
                            accumulated_metrics[key] += batch_metrics[key] / self.accumulation_steps
                
                # Update training metrics
                for key in training_metrics:
                    if key in accumulated_metrics:
                        training_metrics[key] += accumulated_metrics[key]
                
                training_metrics['training_updates'] += 1
            
            state = next_state
            
            if done:
                break
        
        # Average training metrics
        if training_metrics['training_updates'] > 0:
            for key in ['actor_loss', 'critic_loss', 'q_value_mean']:
                training_metrics[key] /= training_metrics['training_updates']
        
        return {
            'episode_reward': episode_reward,
            'episode_steps': episode_steps,
            'final_balance': info.get('balance', 0),
            'portfolio_value': info.get('portfolio_value', 0),
            **training_metrics
        }
    
    def _train_batch(self, agent: DDPGAgent, states: torch.Tensor, actions: torch.Tensor,
                    rewards: torch.Tensor, next_states: torch.Tensor, dones: torch.Tensor,
                    accumulation_step: int, total_accumulation_steps: int) -> Dict[str, float]:
        """Train on single batch with gradient accumulation"""
        
        # Update Critic
        with torch.no_grad():
            next_actions = agent.target_actor.module(next_states)
            target_q_values = agent.target_critic.module(next_states, next_actions)
            target_q_values = rewards + (agent.gamma * target_q_values * ~dones)
        
        current_q_values = agent.critic.module(states, actions)
        critic_loss = torch.nn.functional.mse_loss(current_q_values, target_q_values)
        
        # Scale loss for gradient accumulation
        critic_loss = critic_loss / total_accumulation_steps
        
        # Backward pass
        critic_loss.backward()
        
        # Update critic on last accumulation step
        if accumulation_step == total_accumulation_steps - 1:
            torch.nn.utils.clip_grad_norm_(agent.critic.parameters(), 1.0)
            agent.critic_optimizer.step()
            agent.critic_optimizer.zero_grad()
        
        # Update Actor
        predicted_actions = agent.actor.module(states)
        actor_loss = -agent.critic.module(states, predicted_actions).mean()
        
        # Scale loss for gradient accumulation
        actor_loss = actor_loss / total_accumulation_steps
        
        # Backward pass
        actor_loss.backward()
        
        # Update actor on last accumulation step
        if accumulation_step == total_accumulation_steps - 1:
            torch.nn.utils.clip_grad_norm_(agent.actor.parameters(), 1.0)
            agent.actor_optimizer.step()
            agent.actor_optimizer.zero_grad()
            
            # Update target networks
            agent._soft_update(agent.target_actor.module, agent.actor.module, agent.tau)
            agent._soft_update(agent.target_critic.module, agent.critic.module, agent.tau)
        
        return {
            'actor_loss': actor_loss.item() * total_accumulation_steps,
            'critic_loss': critic_loss.item() * total_accumulation_steps,
            'q_value_mean': current_q_values.mean().item()
        }
    
    def train_distributed(self, rank: int, world_size: int):
        """Main distributed training function"""
        try:
            # Setup distributed training
            self.setup_distributed(rank, world_size)
            
            # Create agent and environment
            agent = self.create_agent()
            env = DeFiTradingEnvironment()
            
            # Training loop
            for episode in range(self.episodes):
                metrics = self.train_episode(agent, env)
                
                # Log metrics (only from rank 0)
                if self.rank == 0 and episode % 10 == 0:
                    logger.info(f"Episode {episode}: "
                              f"Reward={metrics['episode_reward']:.2f}, "
                              f"Steps={metrics['episode_steps']}, "
                              f"Balance={metrics['final_balance']:.2f}")
                    
                    if metrics['training_updates'] > 0:
                        logger.info(f"Training metrics: "
                                  f"Actor Loss={metrics['actor_loss']:.4f}, "
                                  f"Critic Loss={metrics['critic_loss']:.4f}, "
                                  f"Q Value Mean={metrics['q_value_mean']:.4f}")
                
                # Save checkpoint periodically (only from rank 0)
                if self.rank == 0 and episode % 100 == 0 and episode > 0:
                    checkpoint_path = f"checkpoints/ddpg_episode_{episode}.pt"
                    os.makedirs("checkpoints", exist_ok=True)
                    agent.save_model(checkpoint_path)
        
        except Exception as e:
            logger.error(f"Training failed on rank {rank}: {e}")
            raise
        
        finally:
            self.cleanup_distributed()
    
    def run_training(self):
        """Launch multi-GPU training"""
        logger.info(f"Starting multi-GPU training with {self.world_size} GPUs")
        
        if self.world_size > 1:
            # Spawn processes for each GPU
            mp.spawn(
                self.train_distributed,
                args=(self.world_size,),
                nprocs=self.world_size,
                join=True
            )
        else:
            # Single GPU training
            self.train_distributed(0, 1)
        
        logger.info("Training completed!")

def main():
    """Main training function"""
    import argparse
    import json
    
    parser = argparse.ArgumentParser(description='Multi-GPU DeFi Trading Model Training')
    parser.add_argument('--config', type=str, default='config/training_config.json',
                       help='Path to training configuration file')
    parser.add_argument('--world-size', type=int, default=None,
                       help='Number of GPUs to use (default: all available)')
    
    args = parser.parse_args()
    
    # Load configuration
    if os.path.exists(args.config):
        with open(args.config, 'r') as f:
            config = json.load(f)
    else:
        # Default configuration
        config = {
            'batch_size': 256,
            'accumulation_steps': 4,
            'state_dim': 20,
            'action_dim': 2,
            'hidden_dim': 256,
            'lr_actor': 1e-4,
            'lr_critic': 1e-3,
            'episodes': 1000,
            'max_steps_per_episode': 500,
            'train_freq': 1
        }
    
    if args.world_size is not None:
        config['world_size'] = args.world_size
    
    # Initialize trainer
    trainer = MultiGPUTrainer(config)
    
    # Start training
    trainer.run_training()

if __name__ == '__main__':
    main()