// AI Hub — new feature. Safe to delete without affecting existing app.
//
// The last gate before a notification leaves for a real person's phone.
//
// A tap-to-confirm dialog is muscle memory — by the third send the admin is confirming without
// reading, which is exactly when the wrong template goes to the wrong segment. Typing a word cannot
// be done by reflex: it forces a deliberate pause, and the pause is the whole feature.
//
// It also states the thing that is easy to forget once these screens feel routine: there is no
// staging environment behind them. The app talks to the production database and the recipients are
// real people who will see this on their lock screen.
import React from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export const CONFIRM_WORD = 'SEND';

/** The single source of truth for "may this send proceed?". Both admin screens gate on THIS, so the
 *  rule cannot drift between them. Exact match, trimmed — deliberately case-SENSITIVE. */
export function confirmSatisfied(typed: string | null | undefined, word: string = CONFIRM_WORD): boolean {
  return String(typed ?? '').trim() === word;
}

export default function TypeToConfirm({
  value,
  onChange,
  word = CONFIRM_WORD,
  audience,
  headline,
  detail,
  disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  word?: string;
  /** Who receives this, in plain words — e.g. "Rishi Samadhiya" or "24 people in ‘No résumé yet’". */
  audience?: string;
  /** Override the warning for a caller whose action is not "a message goes to someone". Without
   *  this, the send-specific wording ("will receive this on their real device") would be a lie on
   *  any other screen — and a warning that is not true is worse than none, because it teaches the
   *  reader to skim. */
  headline?: string;
  detail?: string;
  disabled?: boolean;
}) {
  const ok = confirmSatisfied(value, word);
  const typedSomething = String(value ?? '').trim().length > 0;
  return (
    <View style={s.wrap}>
      <View style={s.warnRow}>
        <Ionicons name="warning" size={18} color="#7A2E0E" style={{ marginTop: 1 }} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.warnT}>{headline || 'This is the live production database'}</Text>
          <Text style={s.warnB}>
            {detail || `${audience || 'They'} will receive this on their real device. It cannot be recalled once sent.`}
          </Text>
        </View>
      </View>

      <Text style={s.label}>
        Type <Text style={s.word}>{word}</Text> to confirm
      </Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        editable={!disabled}
        placeholder={word}
        placeholderTextColor="#B9A48A"
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        style={[s.input, ok && s.inputOk, typedSomething && !ok && s.inputBad]}
        accessibilityLabel={`Type ${word} to confirm sending`}
      />
      {typedSomething && !ok ? (
        <Text style={s.hint}>Does not match — type {word} exactly.</Text>
      ) : (
        <Text style={[s.hint, ok && s.hintOk]}>
          {ok ? 'Confirmed — the send button is now active.' : 'The send button stays disabled until this matches.'}
        </Text>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    backgroundColor: '#FFF7ED', borderColor: '#F59E0B', borderWidth: 1,
    borderRadius: 14, padding: 13, marginTop: 14,
  },
  warnRow: { flexDirection: 'row', gap: 9, alignItems: 'flex-start' },
  warnT: { fontSize: 13, fontWeight: '800', color: '#7A2E0E' },
  warnB: { fontSize: 12, color: '#8A4B12', marginTop: 3, lineHeight: 17 },
  label: { fontSize: 11.5, fontWeight: '800', color: '#7A2E0E', letterSpacing: 0.5, marginTop: 13, marginBottom: 6 },
  word: { fontFamily: 'Menlo', fontWeight: '800', color: '#7A2E0E' },
  input: {
    backgroundColor: '#FFFFFF', borderWidth: 1.5, borderColor: '#E7C99B', borderRadius: 11,
    paddingHorizontal: 13, height: 46, fontSize: 16, fontWeight: '800', letterSpacing: 2,
    color: '#0B0F22',
  },
  inputOk: { borderColor: '#10B981', backgroundColor: '#F0FDF9' },
  inputBad: { borderColor: '#EF4444' },
  hint: { fontSize: 11.5, color: '#8A4B12', marginTop: 6 },
  hintOk: { color: '#047857', fontWeight: '700' },
});
