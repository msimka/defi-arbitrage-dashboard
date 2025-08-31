import torch
import torch.nn as nn
import torch.optim as optim
import torch.nn.functional as F
import numpy as np
from collections import deque
import random
from typing import Dict, List, Tuple, Optional
import logging

logger = logging.getLogger(__name__)

class ActorNetwork(nn.Module):
    """Actor network for continuous action spaces in DeFi trading"""
    
    def __init__(self, state_dim: int, action_dim: int, hidden_dim: int = 256):
        super(ActorNetwork, self).__init__()
        
        # Multi-layer network for complex DeFi patterns
        self.fc1 = nn.Linear(state_dim, hidden_dim)
        self.fc2 = nn.Linear(hidden_dim, hidden_dim)
        self.fc3 = nn.Linear(hidden_dim, hidden_dim // 2)
        self.fc4 = nn.Linear(hidden_dim // 2, action_dim)
        
        # Layer normalization for stable training
        self.ln1 = nn.LayerNorm(hidden_dim)
        self.ln2 = nn.LayerNorm(hidden_dim)
        self.ln3 = nn.LayerNorm(hidden_dim // 2)
        
        # Dropout for regularization
        self.dropout = nn.Dropout(0.1)
        
        # Initialize weights with Xavier initialization
        self.apply(self._init_weights)
    
    def _init_weights(self, module):
        if isinstance(module, nn.Linear):
            nn.init.xavier_uniform_(module.weight)
            nn.init.zeros_(module.bias)
    
    def forward(self, state: torch.Tensor) -> torch.Tensor:
        """
        Forward pass through actor network
        
        Args:
            state: Market state tensor [batch_size, state_dim]
            
        Returns:
            actions: Continuous actions [batch_size, action_dim]
        """
        x = F.relu(self.ln1(self.fc1(state)))
        x = self.dropout(x)
        x = F.relu(self.ln2(self.fc2(x)))
        x = self.dropout(x)
        x = F.relu(self.ln3(self.fc3(x)))
        
        # Tanh activation for bounded actions (-1, 1)
        actions = torch.tanh(self.fc4(x))
        
        return actions

class CriticNetwork(nn.Module):
    """Critic network for state-action value estimation"""
    
    def __init__(self, state_dim: int, action_dim: int, hidden_dim: int = 256):
        super(CriticNetwork, self).__init__()
        
        # State processing layers
        self.state_fc1 = nn.Linear(state_dim, hidden_dim // 2)
        self.state_fc2 = nn.Linear(hidden_dim // 2, hidden_dim // 2)
        
        # Action processing layers
        self.action_fc1 = nn.Linear(action_dim, hidden_dim // 2)
        
        # Combined processing
        self.combined_fc1 = nn.Linear(hidden_dim, hidden_dim)
        self.combined_fc2 = nn.Linear(hidden_dim, hidden_dim // 2)
        self.value_head = nn.Linear(hidden_dim // 2, 1)
        
        # Layer normalization
        self.ln1 = nn.LayerNorm(hidden_dim // 2)
        self.ln2 = nn.LayerNorm(hidden_dim // 2)
        self.ln3 = nn.LayerNorm(hidden_dim)
        self.ln4 = nn.LayerNorm(hidden_dim // 2)
        
        self.dropout = nn.Dropout(0.1)
        self.apply(self._init_weights)
    
    def _init_weights(self, module):
        if isinstance(module, nn.Linear):
            nn.init.xavier_uniform_(module.weight)
            nn.init.zeros_(module.bias)
    
    def forward(self, state: torch.Tensor, action: torch.Tensor) -> torch.Tensor:
        """
        Forward pass through critic network
        
        Args:
            state: Market state tensor [batch_size, state_dim]
            action: Action tensor [batch_size, action_dim]
            
        Returns:
            q_value: Q-value estimation [batch_size, 1]
        """
        # Process state
        state_features = F.relu(self.ln1(self.state_fc1(state)))
        state_features = F.relu(self.ln2(self.state_fc2(state_features)))
        
        # Process action
        action_features = F.relu(self.action_fc1(action))
        
        # Combine state and action features
        combined = torch.cat([state_features, action_features], dim=1)
        combined = F.relu(self.ln3(self.combined_fc1(combined)))
        combined = self.dropout(combined)
        combined = F.relu(self.ln4(self.combined_fc2(combined)))
        
        # Output Q-value
        q_value = self.value_head(combined)
        
        return q_value

class ReplayBuffer:
    """Experience replay buffer for stable training"""
    
    def __init__(self, max_size: int = 100000):
        self.buffer = deque(maxlen=max_size)
        self.max_size = max_size
    
    def push(self, state: np.ndarray, action: np.ndarray, reward: float, 
             next_state: np.ndarray, done: bool):
        """Add experience to buffer"""
        experience = (state, action, reward, next_state, done)
        self.buffer.append(experience)
    
    def sample(self, batch_size: int) -> Tuple[torch.Tensor, ...]:
        """Sample batch of experiences"""
        if len(self.buffer) < batch_size:
            batch_size = len(self.buffer)
        
        batch = random.sample(self.buffer, batch_size)
        
        states = torch.FloatTensor([e[0] for e in batch])
        actions = torch.FloatTensor([e[1] for e in batch])
        rewards = torch.FloatTensor([e[2] for e in batch]).unsqueeze(1)
        next_states = torch.FloatTensor([e[3] for e in batch])
        dones = torch.BoolTensor([e[4] for e in batch]).unsqueeze(1)
        
        return states, actions, rewards, next_states, dones
    
    def __len__(self):
        return len(self.buffer)

class DDPGAgent:
    """Deep Deterministic Policy Gradient agent for DeFi trading"""
    
    def __init__(self, state_dim: int, action_dim: int, device: str = 'cuda', 
                 lr_actor: float = 1e-4, lr_critic: float = 1e-3,
                 gamma: float = 0.99, tau: float = 0.005,
                 noise_std: float = 0.1, hidden_dim: int = 256):
        
        self.device = torch.device(device)
        self.state_dim = state_dim
        self.action_dim = action_dim
        self.gamma = gamma
        self.tau = tau
        self.noise_std = noise_std
        
        # Networks
        self.actor = ActorNetwork(state_dim, action_dim, hidden_dim).to(self.device)
        self.critic = CriticNetwork(state_dim, action_dim, hidden_dim).to(self.device)
        self.target_actor = ActorNetwork(state_dim, action_dim, hidden_dim).to(self.device)
        self.target_critic = CriticNetwork(state_dim, action_dim, hidden_dim).to(self.device)
        
        # Copy weights to target networks
        self.target_actor.load_state_dict(self.actor.state_dict())
        self.target_critic.load_state_dict(self.critic.state_dict())
        
        # Optimizers
        self.actor_optimizer = optim.AdamW(self.actor.parameters(), lr=lr_actor)
        self.critic_optimizer = optim.AdamW(self.critic.parameters(), lr=lr_critic)
        
        # Experience replay
        self.replay_buffer = ReplayBuffer()
        
        # Training metrics
        self.training_step = 0
        self.actor_losses = []
        self.critic_losses = []
        
        logger.info(f"DDPG Agent initialized with state_dim={state_dim}, action_dim={action_dim}")
    
    def select_action(self, state: np.ndarray, add_noise: bool = True) -> np.ndarray:
        """Select action using current policy"""
        state = torch.FloatTensor(state).unsqueeze(0).to(self.device)
        
        with torch.no_grad():
            action = self.actor(state).cpu().numpy()[0]
        
        if add_noise:
            # Add exploration noise
            noise = np.random.normal(0, self.noise_std, size=action.shape)
            action = np.clip(action + noise, -1, 1)
        
        return action
    
    def store_transition(self, state: np.ndarray, action: np.ndarray, reward: float,
                        next_state: np.ndarray, done: bool):
        """Store experience in replay buffer"""
        self.replay_buffer.push(state, action, reward, next_state, done)
    
    def train(self, batch_size: int = 256) -> Dict[str, float]:
        """Train the agent using batch of experiences"""
        if len(self.replay_buffer) < batch_size:
            return {}
        
        # Sample batch
        states, actions, rewards, next_states, dones = self.replay_buffer.sample(batch_size)
        states = states.to(self.device)
        actions = actions.to(self.device)
        rewards = rewards.to(self.device)
        next_states = next_states.to(self.device)
        dones = dones.to(self.device)
        
        # Update Critic
        with torch.no_grad():
            next_actions = self.target_actor(next_states)
            target_q_values = self.target_critic(next_states, next_actions)
            target_q_values = rewards + (self.gamma * target_q_values * ~dones)
        
        current_q_values = self.critic(states, actions)
        critic_loss = F.mse_loss(current_q_values, target_q_values)
        
        self.critic_optimizer.zero_grad()
        critic_loss.backward()
        torch.nn.utils.clip_grad_norm_(self.critic.parameters(), 1.0)
        self.critic_optimizer.step()
        
        # Update Actor
        predicted_actions = self.actor(states)
        actor_loss = -self.critic(states, predicted_actions).mean()
        
        self.actor_optimizer.zero_grad()
        actor_loss.backward()
        torch.nn.utils.clip_grad_norm_(self.actor.parameters(), 1.0)
        self.actor_optimizer.step()
        
        # Update target networks
        self._soft_update(self.target_actor, self.actor, self.tau)
        self._soft_update(self.target_critic, self.critic, self.tau)
        
        # Update training metrics
        self.training_step += 1
        self.actor_losses.append(actor_loss.item())
        self.critic_losses.append(critic_loss.item())
        
        return {
            'actor_loss': actor_loss.item(),
            'critic_loss': critic_loss.item(),
            'q_value_mean': current_q_values.mean().item(),
            'training_step': self.training_step
        }
    
    def _soft_update(self, target_net: nn.Module, source_net: nn.Module, tau: float):
        """Soft update of target network parameters"""
        for target_param, source_param in zip(target_net.parameters(), source_net.parameters()):
            target_param.data.copy_(tau * source_param.data + (1.0 - tau) * target_param.data)
    
    def save_model(self, filepath: str):
        """Save model checkpoints"""
        torch.save({
            'actor_state_dict': self.actor.state_dict(),
            'critic_state_dict': self.critic.state_dict(),
            'target_actor_state_dict': self.target_actor.state_dict(),
            'target_critic_state_dict': self.target_critic.state_dict(),
            'actor_optimizer': self.actor_optimizer.state_dict(),
            'critic_optimizer': self.critic_optimizer.state_dict(),
            'training_step': self.training_step,
            'config': {
                'state_dim': self.state_dim,
                'action_dim': self.action_dim,
                'gamma': self.gamma,
                'tau': self.tau,
                'noise_std': self.noise_std
            }
        }, filepath)
        logger.info(f"Model saved to {filepath}")
    
    def load_model(self, filepath: str):
        """Load model checkpoints"""
        checkpoint = torch.load(filepath, map_location=self.device)
        
        self.actor.load_state_dict(checkpoint['actor_state_dict'])
        self.critic.load_state_dict(checkpoint['critic_state_dict'])
        self.target_actor.load_state_dict(checkpoint['target_actor_state_dict'])
        self.target_critic.load_state_dict(checkpoint['target_critic_state_dict'])
        self.actor_optimizer.load_state_dict(checkpoint['actor_optimizer'])
        self.critic_optimizer.load_state_dict(checkpoint['critic_optimizer'])
        self.training_step = checkpoint['training_step']
        
        logger.info(f"Model loaded from {filepath}")

class DeFiTradingEnvironment:
    """Trading environment for DeFi strategies"""
    
    def __init__(self, initial_balance: float = 10000.0, 
                 transaction_fee: float = 0.003,
                 max_position_size: float = 0.5):
        self.initial_balance = initial_balance
        self.transaction_fee = transaction_fee
        self.max_position_size = max_position_size
        self.reset()
    
    def reset(self) -> np.ndarray:
        """Reset environment to initial state"""
        self.balance = self.initial_balance
        self.positions = {}  # {token: amount}
        self.portfolio_value = self.initial_balance
        self.step_count = 0
        self.max_steps = 1000
        
        # Return initial state
        return self._get_state()
    
    def _get_state(self) -> np.ndarray:
        """Get current market state"""
        # This would be populated with real market data
        # For now, return dummy state
        state = np.array([
            self.balance / self.initial_balance,  # Normalized balance
            len(self.positions),  # Number of positions
            self.portfolio_value / self.initial_balance,  # Normalized portfolio value
            self.step_count / self.max_steps,  # Progress through episode
        ] + [0.0] * 16)  # Placeholder for market data (20 total features)
        
        return state
    
    def step(self, action: np.ndarray) -> Tuple[np.ndarray, float, bool, Dict]:
        """Execute action and return next state, reward, done, info"""
        self.step_count += 1
        
        # Decode action (simplified example)
        # action[0]: buy/sell signal (-1 to 1)
        # action[1]: position size (0 to 1)
        trade_signal = action[0]
        position_size = abs(action[1]) * self.max_position_size
        
        # Execute trade (simplified)
        reward = self._execute_trade(trade_signal, position_size)
        
        # Check if episode is done
        done = self.step_count >= self.max_steps or self.balance <= 0
        
        # Get next state
        next_state = self._get_state()
        
        info = {
            'balance': self.balance,
            'portfolio_value': self.portfolio_value,
            'num_positions': len(self.positions)
        }
        
        return next_state, reward, done, info
    
    def _execute_trade(self, signal: float, size: float) -> float:
        """Execute trade and return reward"""
        # Simplified trading logic
        # In practice, this would interface with actual DEX protocols
        
        trade_amount = self.balance * size
        fee = trade_amount * self.transaction_fee
        
        if signal > 0.1:  # Buy
            if self.balance >= trade_amount + fee:
                self.balance -= (trade_amount + fee)
                # Simulate price change and profit/loss
                price_change = np.random.normal(0.001, 0.02)  # 0.1% mean, 2% std
                profit = trade_amount * price_change
                self.balance += trade_amount + profit
                return profit
        elif signal < -0.1:  # Sell
            # Similar sell logic
            price_change = np.random.normal(-0.001, 0.02)
            profit = trade_amount * price_change
            self.balance += profit
            return profit
        
        return 0.0  # No trade executed