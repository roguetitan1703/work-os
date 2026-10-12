module.exports = {
  apps: [
    {
      name: "work-os",
      script: "node_modules/next/dist/bin/next",
      args: "start",
      cwd: "D:/Work/Delpat/projects/Om/work mode os/work-os",
      env: {
        NODE_ENV: "production"
      }
    }
  ]
}