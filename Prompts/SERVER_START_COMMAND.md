# Server Start Command

## Quick Command

To run/restart all servers properly:

```bash
bash start-all.sh
```

## What to tell the AI

Simply say:

> **"Run start-all.sh"**

Or:

> **"Start all servers"**

Or:

> **"Restart servers"**

## What It Does

1. ✅ Stops all running Node.js and Expo processes
2. ✅ Detects your current IP address automatically (no hardcoding)
3. ✅ Updates `MobileApp/config.js` with the correct IP
4. ✅ Starts backend server on port 3000
5. ✅ Starts Expo with tunnel option for easier connection
6. ✅ Both servers use the same IP configuration

## No More Issues

- ❌ No more IP mismatches
- ❌ No more login failures
- ❌ No more hardcoded IPs
- ❌ No more manual configuration

## Server Details

After running, you'll see:
- Backend API: `http://<YOUR_IP>:3000`
- Expo Metro: `exp://<YOUR_IP>:8081`
- Backend PID and Expo PID for monitoring

## To Stop Servers

```bash
pkill -9 node; pkill -9 expo
```

Or just tell the AI: **"Stop all servers"**
