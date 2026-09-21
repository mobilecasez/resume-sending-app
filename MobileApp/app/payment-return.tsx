// AI Hub — new feature. Safe to delete without affecting existing app.
//
// Catch-all for cvapplyr://payment-return?txn=… — the last page of BillDesk's payment tab sends the user
// back here. The browser session that opened the tab normally captures this link itself; when the OS
// routes it into the app instead, this screen stops expo-router from showing "unmatched route" and steps
// straight back to wherever the purchase started. It decides nothing: the plans screen asks the server.
import React, { useEffect } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

export default function PaymentReturn() {
  const router = useRouter();
  useEffect(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(subscription)/plans');
  }, [router]);
  return <View />;
}
