// Send a push notification via the Expo Push API — a single HTTPS POST, no SDK.
// https://docs.expo.dev/push-notifications/sending-notifications/
// Tokens look like ExponentPushToken[xxx]. Best-effort: never throws (push must not break a search).
'use strict';

async function sendPushNotification(pushToken, title, body, data = {}) {
    if (!pushToken || !/^Expo(nent)?PushToken\[/.test(pushToken)) return false;
    try {
        const r = await fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ to: pushToken, title, body, data, sound: 'default', priority: 'high', channelId: 'default' }),
            signal: AbortSignal.timeout(9000),
        });
        const j = await r.json().catch(() => ({}));
        const ticket = j && j.data;
        if (ticket && ticket.status === 'error') {
            // DeviceNotRegistered → the token is stale; caller may clear it.
            console.warn('[push] expo error:', JSON.stringify(ticket.details || ticket.message || ''));
            return ticket.details && ticket.details.error === 'DeviceNotRegistered' ? 'stale' : false;
        }
        return true;
    } catch (e) {
        console.warn('[push] send failed:', e.message);
        return false;
    }
}

module.exports = { sendPushNotification };
