// AI Hub — new feature. Safe to delete without affecting existing app.
//
// Which company the résumé being edited is FOR, carried across the builder's screens.
//
// ⚠️ THIS EXISTS BECAUSE A NAMELESS DOWNLOAD IS A DOWNLOAD NOBODY CAN BE CHARGED FOR PROPERLY.
// A download pass buys one EMPLOYER. Home's "View PDF" opens the design gallery with the company
// in the route params, so the payment has something to attach to — but the editor's
// "Download / Preview" button opened the very same gallery with nothing, and preview.tsx has no
// params of its own to inherit from. Every download taken through that door arrived at the server
// with employer:null, which the server can only charge into its "(none)" scope: the pass is spent,
// but on a company that does not exist, and the user's real employer has to take it over later.
//
// So the company is remembered the moment Home knows it, and read back one screen later. It is
// deliberately a hint and never an authority: the SERVER decides what a download costs, and a
// missing value here just means the old nameless behaviour.
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'resume_builder_employer';

/** Remember the company the builder was opened for. An empty value clears it. */
export async function rememberBuilderEmployer(company?: string | null): Promise<void> {
  const v = String(company || '').trim();
  try {
    if (v) await AsyncStorage.setItem(KEY, v);
    else await AsyncStorage.removeItem(KEY);
  } catch { /* a hint that fails to persist is not worth failing navigation over */ }
}

/** The company the builder was opened for, or null when it was opened from nowhere in particular. */
export async function readBuilderEmployer(): Promise<string | null> {
  try {
    const v = await AsyncStorage.getItem(KEY);
    return v && v.trim() ? v.trim() : null;
  } catch { return null; }
}
