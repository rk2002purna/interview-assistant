/**
 * PM2 configuration for a versioned EC2 release. Using __dirname keeps this
 * portable across release directories and allows deploy.sh to roll back by
 * changing only the current symlink.
 */
module.exports = {
  apps: [
    {
      name: 'interview-assistant-backend',
      script: 'dist/server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      restart_delay: 5000,
      max_memory_restart: '1G',
      kill_timeout: 15000,
      env_production: {
        NODE_ENV: 'production',
        PORT: 8787,
      },
      error_file: '/var/log/upnod/backend-error.log',
      out_file: '/var/log/upnod/backend-out.log',
      // No log_date_format: the app already stamps each JSON line with its own
      // `timestamp` field. Keeping stdout as pure JSON lets the CloudWatch
      // agent and Logs Insights auto-parse fields (status, path, latency_ms).
      merge_logs: true,
    },
  ],
};
