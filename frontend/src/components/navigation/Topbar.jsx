import { AppBar, Toolbar, IconButton, Box, Avatar, Button, Tooltip } from '@mui/material';
import { Menu, Sun, Moon, LogOut } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { useSimulation } from '../../context/SimulationContext';
import LiveDot from '../common/LiveDot';
import styles from './Topbar.module.css';

export default function Topbar({ handleDrawerToggle }) {
  const { user, logout } = useAuth();
  const { isDark, toggleTheme } = useTheme();
  const { connected } = useSimulation();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <AppBar position="fixed" color="inherit" elevation={0} className={styles.appBar}>
      <Toolbar className={styles.toolbar}>
        <IconButton
          color="inherit"
          aria-label="open drawer"
          edge="start"
          onClick={() => handleDrawerToggle(true)}
          className={styles.menuButton}
        >
          <Menu size={20} />
        </IconButton>

        <Box className={styles.spacer} />

        <Box className={styles.actions}>
          <Tooltip title={connected ? 'Simulation running' : 'Disconnected from server'}>
            <Box className={styles.liveStatus}>
              <LiveDot active={connected} />
              <span className={styles.liveLabel}>
                {connected ? 'Live' : 'Offline'}
              </span>
            </Box>
          </Tooltip>
          <IconButton
            color="inherit"
            aria-label="toggle dark mode"
            onClick={toggleTheme}
            size="small"
          >
            {isDark ? <Sun size={18} /> : <Moon size={18} />}
          </IconButton>
          <Button
            variant="outlined"
            size="small"
            onClick={handleLogout}
            startIcon={<LogOut size={16} />}
            className={styles.logoutButton}
          >
            Log out
          </Button>
          <Avatar className={styles.avatar}>
            {user?.email ? user.email.slice(0, 2).toUpperCase() : 'AD'}
          </Avatar>
        </Box>
      </Toolbar>
    </AppBar>
  );
}
