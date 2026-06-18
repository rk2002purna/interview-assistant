/**
 * PM2 ecosystem config for the interview-assistant backend.
 * Usage on server: pm2 start ecosystem.config.cjs --env production
 */
module.exports = {
  apps: [
    {
      name: 'interview-assistant-backend',
      script: 'dist/server.js',
      cwd: '/home/ubuntu/interview-assistant/backend',
      instances: 1,
      autorestart: true,
      watch: false,
      env_production: {
        NODE_ENV: 'production',
        PORT: 8787,
      },
      error_file: '/var/log/pm2/interview-assistant-error.log',
      out_file: '/var/log/pm2/interview-assistant-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
