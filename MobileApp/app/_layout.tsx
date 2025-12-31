import { StatusBar } from 'expo-status-bar';
import App from '../App';

export default function RootLayout() {
  return (
    <>
      <App />
      <StatusBar style="auto" />
    </>
  );
}
