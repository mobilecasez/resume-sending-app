// AI Hub — new feature. Safe to delete without affecting existing app.
//
// "TAILOR YOUR RESUME FOR ACME?" — THE QUESTION HOME ASKS BEFORE ANYTHING IS SPENT.
//
// Tailor, Write, Refresh and the Add-employer auto build all land here first (the product owner, 2026-09-14):
// what tailoring does, how many generations are left — or that the one-time pass covers this employer — and
// Continue / Cancel. With none left it is the same sheet, empty: "Generate once" for this one employer, or See
// plans. useHomeBuilds decides which question is asked and what every button does (K.confirm); this file draws it.
//
// ⚠️ THIS FILE STARTS NOTHING, BUYS NOTHING AND CHARGES NOTHING. Every button only calls back — the purchase, the
// gate reads around it and the build all belong to useHomeBuilds. The letters auto-regen incident came from a
// SCREEN deciding to spend. A cache hit (a document already built, free) never reaches this sheet at all.
//
// ⚠️ EVERY NUMBER IS THE SERVER'S. The counts are the gate's `usage`, drawn as they came; a count that is missing
// is a sentence without a number, never a guessed one. WHAT PAYS is the hook's call (ConfirmSheetView): in
// confirm mode the pass pays exactly when `pass.available`, and an empty sheet's `pass.available` means a pass was
// already bought from this very sheet — so the button uses it rather than selling a second one. That includes one
// the store has charged for and the server has not shown yet (`payment`).
//
// ⚠️ PRICES COME FROM THE STORE. The pass's price is the store's own localised string (fetchPassPrice, the way
// DownloadPaywallSheet reads it — ₹99 in India, $0.99 in the US). "$0.99" is only a LABEL for when the store has
// not priced it; the purchase itself always goes through the store at the store's price.
//
// ⚠️ NO USER SEES THE WORD "CREDITS". Generation is paid by a plan, the free allowance or the pass (2026-09-13).
//
// ⚠️ BUSY LOCKS THE SHEET. While a purchase or a gate read around it runs, the backdrop, the back button and every
// button do nothing: a second tap on Generate once would be a second store sheet. ⚠️ EXCEPT ONCE THE STORE HAS
// ANSWERED (`canCancel`): applying a pass and reading the gate again is a wait, not a purchase, and a slow network
// used to hold the whole sheet shut through it. Cancel then leaves — and what was paid for stays theirs.
//
// ⚠️ `payment` IS A PURCHASE THE SERVER HAS NOT SHOWN YET, and it changes what is said, never what is offered:
// 'applying' = the store charged them and the pass is on its way; 'approval' = Ask-to-Buy, where nothing is charged
// until it clears. Both draw the OWNED face (the button uses the pass; it never sells a second one), because a
// payment we cannot see yet is still a payment.
//
// ⚠️ IT HIDES WHILE ANOTHER SCREEN IS UP (DownloadPaywallSheet's lesson). A react-native Modal floats above the
// whole navigator, so a question left open when Home is covered would cover that screen. It stays asked, and
// comes back with Home.
//
// ⚠️ NO EXIT ANIMATION. The Modal goes the moment `visible` turns false, because useHomeBuilds times the next Modal
// (the progress overlay after Continue) from that moment — MODAL_GAP_MS. A sheet still sliding out while the
// overlay is presented is exactly the silent UIKit refusal that gap exists to avoid. ⚠️ And a presentation is
// PROVEN, never assumed: no onShow in PRESENT_RETRY_MS and the Modal tries again (another Modal was still up).
//
// ⚠️ ANIMATION DRIVER RULE (the b126-128 fatal crash): a Modal is its own view tree, and its ONE Animated value is
// useNativeDriver:true on opacity and transform only — the backdrop's fade, the sheet's rise, the icon's pop. The
// count's dots and meter are plain layout, and nothing in here ticks.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity, Pressable, ActivityIndicator, Animated, Easing, ScrollView,
  AccessibilityInfo,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { E, SERIF, sweepWords } from './theme';
import { fetchPassPrice } from '../../services/downloadPassService';
import type { DocKind, GateUsage, GatePass } from '../../services/homeAddEmployer';
import type { ConfirmSheetView } from './useHomeBuilds';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

/** A label only — shown when the store has no price for the pass (see the header). */
const PRICE_LABEL_FALLBACK = '$0.99';
/** Up to this many, the count is drawn as dots (the free 3, a small plan); past it, a meter. */
const DOTS_MAX = 10;
/**
 * ⚠️ CAPS ON DYNAMIC TYPE, the same reason as BuildingOverlay's: uncapped, the largest accessibility sizes pushed
 * the buttons off a small phone. The copy scrolls; the caps keep Continue and Cancel on the first screenful.
 */
const FONT_CAP = { title: 1.3, body: 1.4, button: 1.3, small: 1.4 };
/** The sheet's own dark glass — Home's navy, lifted a little at the top edge where the grab bar sits. */
const SHEET_BG = ['#151D4A', '#0C1234', '#070A18'] as const;
const WARM = '#FCD34D';
/** How long the OS gets to say whether motion is reduced before the still look is assumed. */
const REDUCE_MOTION_WAIT_MS = 500;
/**
 * How long a presentation may take before it counts as refused. ⚠️ UIKIT REFUSES A SECOND MODAL WITHOUT A WORD:
 * RN (Fabric) presents from the view controller that owns this view, marks the Modal presented BEFORE UIKit
 * answers, and never tries again — so a question raised while another of Home's Modals is up (the Add sheet, the
 * download paywall, the page zoom) would never be seen while it held useHomeBuilds' one question slot. onShow is
 * the only proof a presentation happened: without it in this long, the Modal is mounted afresh and tries again,
 * and it comes up the moment the other one has gone.
 */
const PRESENT_RETRY_MS = 1200;

/**
 * The OS "reduce motion" switch. null = not known yet, and treated as reduced (a fade, no rise): the safe side of
 * a wrong guess is too little motion. This sheet is mounted with Home, so the answer is in long before it opens.
 */
function useReduceMotion(): boolean | null {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => { if (alive) setOn(!!v); })
      .catch(() => { if (alive) setOn((o) => (o === null ? true : o)); });
    const id = setTimeout(() => { if (alive) setOn((o) => (o === null ? true : o)); }, REDUCE_MOTION_WAIT_MS);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => setOn(!!v));
    return () => { alive = false; clearTimeout(id); sub.remove(); };
  }, []);
  return on;
}

/* ── words ──────────────────────────────────────────────────────────────────────────────────── */

type Words = {
  kicker: string;
  /** The title before the employer's name (serif), and the title with no name to show. */
  lead: string;
  bare: string;
  /** What one generation of this kind is called, singular and plural. */
  one: string;
  many: string;
  icon: IconName;
};

const WORDS: Record<DocKind, Words> = {
  resume: {
    kicker: 'AI RESUME TAILORING',
    lead: 'Tailor your resume for',
    bare: 'Tailor your resume',
    one: 'resume generation',
    many: 'resume generations',
    icon: 'color-wand',
  },
  cover_letter: {
    kicker: 'AI COVER LETTER',
    lead: 'Write your cover letter for',
    bare: 'Write your cover letter',
    one: 'cover letter',
    many: 'cover letters',
    icon: 'create',
  },
};

/** An unknown kind falls back to the resume words rather than rendering blanks. */
const wordsFor = (kind: DocKind | undefined): Words => WORDS[kind === 'cover_letter' ? 'cover_letter' : 'resume'];

/**
 * What tailoring does, in three facts. ⚠️ ONLY WHAT THE GENERATOR REALLY DOES: it researches the employer and the
 * hiring conventions of its country and sector, rewrites from the user's OWN experience (it never invents one),
 * and ranks the designs for this employer, saving the document so a design switch costs nothing.
 */
function benefitsFor(kind: DocKind, who: string): Array<{ icon: IconName; title: string; sub: string }> {
  const letter = kind === 'cover_letter';
  return [
    {
      icon: 'globe-outline',
      title: `Researched for ${who}`,
      sub: letter
        ? 'How they hire, and what a cover letter should look like in their country and sector.'
        : 'How they hire, and the CV conventions of their country and sector.',
    },
    {
      icon: letter ? 'create-outline' : 'color-wand-outline',
      title: letter ? 'Written around what they look for' : 'Rewritten around what they look for',
      sub: letter
        ? 'From your own experience — nothing invented.'
        : 'Your own experience, reordered and reworded — nothing invented.',
    },
    {
      icon: 'albums-outline',
      title: letter ? 'Letter designs ranked by fit' : 'Designs ranked by fit',
      sub: `Ranked for ${who} and saved, so switching designs is instant.`,
    },
  ];
}

/** "You've used your 3 free resume generations" — from the count that ran out, or plainly when there is none. */
function emptyTitle(kind: DocKind, usage: GateUsage | null): string {
  const w = wordsFor(kind);
  const n = usage ? usage.allowance : 0;
  const noun = n === 1 ? w.one : w.many;
  if (usage && usage.pool === 'free' && n > 0) return `You’ve used your ${n} free ${noun}`;
  if (usage && usage.pool === 'plan' && n > 0) {
    return `You’ve used this month’s ${n} ${noun}${usage.planLabel ? ` on ${usage.planLabel}` : ''}`;
  }
  return `No ${w.many} left`;
}

/* ── pieces ─────────────────────────────────────────────────────────────────────────────────── */

/** "Tailor your resume for" in the sans, the employer in the sampled-gradient serif — Home's accent line. */
function Title({ lead, company }: { lead: string; company: string }) {
  const words = company ? sweepWords(company) : [];
  return (
    <Text style={s.title} accessibilityRole="header" maxFontSizeMultiplier={FONT_CAP.title}>
      {lead}
      {words.length > 0 && ' '}
      {words.map((wd, i) => (
        <Text key={i} style={[s.titleSerif, { color: wd.c }]}>{wd.w}{i < words.length - 1 ? ' ' : ''}</Text>
      ))}
    </Text>
  );
}

function Benefit({ icon, title, sub, compact }: { icon: IconName; title: string; sub: string; compact: boolean }) {
  return (
    <View style={s.benefit} accessible accessibilityLabel={compact ? title : `${title}. ${sub}`}>
      <View style={[s.benefitIcon, compact && s.benefitIconSm]}>
        <Ionicons name={icon} size={compact ? 14 : 16} color={E.mint} />
      </View>
      <View style={s.benefitTexts}>
        <Text style={s.benefitTitle} maxFontSizeMultiplier={FONT_CAP.body}>{title}</Text>
        {!compact && <Text style={s.benefitSub} maxFontSizeMultiplier={FONT_CAP.small}>{sub}</Text>}
      </View>
    </View>
  );
}

/**
 * The count, seen: "You have 2 of 3 free resume generations left" over three dots, "12 of 15 … left this month · Plus"
 * over a meter, or "Covered by your one-time pass". The dot Continue would use is ringed, so "uses one" is visible.
 * ⚠️ An empty sheet shows its count at zero whatever the numbers say — the gate refused, and that is the answer.
 */
function UsageStrip({ kind, mode, who, usage, pass }: {
  kind: DocKind; mode: 'confirm' | 'empty'; who: string; usage: GateUsage | null; pass: GatePass | null;
}) {
  const w = wordsFor(kind);
  const empty = mode === 'empty';

  if (!empty && pass && pass.available) {
    const title = pass.forThisEmployer ? `Covered by your one-time pass for ${who}` : 'Covered by your one-time pass';
    const sub = pass.forThisEmployer
      ? 'Nothing more to pay.'
      : `Continue puts it on ${who}: one resume, one cover letter and their downloads.`;
    return (
      <View style={s.strip} accessible accessibilityLabel={`${title}. ${sub}`}>
        <View style={s.stripRow}>
          <View style={s.stripIcon}><Ionicons name="ticket-outline" size={17} color={E.mint} /></View>
          <View style={s.stripTexts}>
            <Text style={s.stripTitle} maxFontSizeMultiplier={FONT_CAP.body}>{title}</Text>
            <Text style={s.stripSub} maxFontSizeMultiplier={FONT_CAP.small}>{sub}</Text>
          </View>
        </View>
      </View>
    );
  }

  const allowance = usage ? Math.max(0, Math.floor(usage.allowance)) : 0;
  if (!usage || allowance <= 0) {
    if (empty) return null;
    // Something the user has pays, and the server did not count it for us: say so, without a number.
    const title = 'Included in what you have';
    const sub = `Continue uses one ${w.one}.`;
    return (
      <View style={s.strip} accessible accessibilityLabel={`${title}. ${sub}`}>
        <View style={s.stripRow}>
          <View style={s.stripIcon}><Ionicons name="checkmark-circle-outline" size={17} color={E.mint} /></View>
          <View style={s.stripTexts}>
            <Text style={s.stripTitle} maxFontSizeMultiplier={FONT_CAP.body}>{title}</Text>
            <Text style={s.stripSub} maxFontSizeMultiplier={FONT_CAP.small}>{sub}</Text>
          </View>
        </View>
      </View>
    );
  }

  const left = empty ? 0 : Math.max(0, Math.min(Math.floor(usage.remaining), allowance));
  const noun = allowance === 1 ? w.one : w.many;
  const title = usage.pool === 'free'
    ? `${empty ? '' : 'You have '}${left} of ${allowance} free ${noun} left`
    : usage.pool === 'plan'
      ? `${left} of ${allowance} ${noun} left this month${usage.planLabel ? ` · ${usage.planLabel}` : ''}`
      : `${left} of ${allowance} ${noun} left`;
  const sub = empty
    ? (usage.pool === 'plan' ? 'Your plan’s count refills when it renews.' : usage.oneTime ? 'Free ones are one time — they don’t refill.' : '')
    : (usage.pool === 'plan' ? 'Continue uses one of this month’s.' : usage.oneTime ? 'Continue uses one — free ones don’t refill.' : 'Continue uses one.');

  return (
    <View style={[s.strip, empty && s.stripEmpty]} accessible accessibilityLabel={sub ? `${title}. ${sub}` : title}>
      <Text style={s.stripTitle} maxFontSizeMultiplier={FONT_CAP.body}>{title}</Text>
      {allowance <= DOTS_MAX ? (
        <View style={s.dots}>
          {Array.from({ length: allowance }, (_, i) => (
            <View key={i} style={[s.dot, i < left && s.dotOn, !empty && i === left - 1 && s.dotNext]} />
          ))}
        </View>
      ) : (
        <View style={s.meter}>
          {left > 0 && <View style={[s.meterOn, { flex: left }]} />}
          {allowance - left > 0 && <View style={{ flex: allowance - left }} />}
        </View>
      )}
      {!!sub && <Text style={s.stripSub} maxFontSizeMultiplier={FONT_CAP.small}>{sub}</Text>}
    </View>
  );
}

function Primary({ label, sub, icon, busy, onPress, a11yLabel, a11yHint }: {
  label: string; sub?: string | null; icon: IconName; busy: boolean; onPress: () => void; a11yLabel: string; a11yHint?: string;
}) {
  return (
    <TouchableOpacity
      style={s.primaryWrap} activeOpacity={0.9} onPress={onPress} disabled={busy}
      accessibilityRole="button" accessibilityLabel={a11yLabel} accessibilityHint={a11yHint}
      accessibilityState={{ disabled: busy, busy }}
    >
      <LinearGradient colors={[E.blue, E.purple]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.primary}>
        {busy ? <ActivityIndicator color="#fff" size="small" /> : <Ionicons name={icon} size={17} color="#fff" />}
        <View style={s.primaryTexts}>
          <Text style={s.primaryTx} numberOfLines={2} maxFontSizeMultiplier={FONT_CAP.button}>{label}</Text>
          {!!sub && <Text style={s.primarySub} numberOfLines={2} maxFontSizeMultiplier={FONT_CAP.small}>{sub}</Text>}
        </View>
      </LinearGradient>
    </TouchableOpacity>
  );
}

function Secondary({ label, icon, onPress, disabled, a11yHint }: {
  label: string; icon?: IconName; onPress: () => void; disabled: boolean; a11yHint?: string;
}) {
  return (
    <TouchableOpacity
      style={[s.secondary, disabled && s.dim]} activeOpacity={0.8} onPress={onPress} disabled={disabled}
      accessibilityRole="button" accessibilityLabel={label} accessibilityHint={a11yHint} accessibilityState={{ disabled }}
    >
      {!!icon && <Ionicons name={icon} size={16} color="rgba(255,255,255,0.9)" />}
      <Text style={s.secondaryTx} numberOfLines={1} maxFontSizeMultiplier={FONT_CAP.button}>{label}</Text>
    </TouchableOpacity>
  );
}

/* ── the sheet ──────────────────────────────────────────────────────────────────────────────── */

export default function GenerateConfirmSheet({
  visible, mode, kind, company, usage, pass, busy, error, payment, canCancel, onContinue, onCancel, onBuyOnce, onSeePlans,
}: ConfirmSheetView) {
  const insets = useSafeAreaInsets();
  // False the moment another screen covers Home (the plans screen, the builder): the question waits under it.
  // From expo-router's focus effect (the project's rule: navigation hooks come from expo-router) — on while Home
  // is focused, off from its blur until it is focused again.
  const [focused, setFocused] = useState(false);
  useFocusEffect(useCallback(() => {
    setFocused(true);
    return () => setFocused(false);
  }, []));
  const reduce = useReduceMotion();
  const open = !!visible && focused;
  const t = useRef(new Animated.Value(0)).current;
  const [price, setPrice] = useState<string | null>(null);
  // Which presentation this is (the Modal's key) and whether it was really shown — see PRESENT_RETRY_MS.
  const [attempt, setAttempt] = useState(0);
  const presented = useRef(false);

  useEffect(() => {
    if (!open) { presented.current = false; return; }
    const id = setTimeout(() => { if (!presented.current) setAttempt((n) => n + 1); }, PRESENT_RETRY_MS);
    return () => clearTimeout(id);
  }, [open, attempt]);

  useEffect(() => {
    t.setValue(0);
    if (!open) return;
    const a = Animated.timing(t, { toValue: 1, duration: 300, easing: Easing.out(Easing.cubic), useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [open, attempt, t]);

  // The store's own price for the pass, read each time the empty sheet opens. The last one found stays on screen.
  useEffect(() => {
    if (!open || mode !== 'empty') return;
    let alive = true;
    fetchPassPrice().then((p) => { if (alive && p) setPrice(p); }).catch(() => {});
    return () => { alive = false; };
  }, [open, mode]);

  // A failure (or a note that must be read) lands under the buttons VoiceOver's focus is on: say it out loud.
  useEffect(() => {
    if (open && error) AccessibilityInfo.announceForAccessibility(error);
  }, [open, error]);

  // All on the one native value: the backdrop fades, the sheet rises (not under reduce motion), the icon pops.
  const still = reduce !== false;
  const motion = useMemo(() => ({
    scrim: t,
    sheet: {
      opacity: t.interpolate({ inputRange: [0, 0.3, 1], outputRange: [still ? 0 : 1, 1, 1] }),
      transform: [{ translateY: t.interpolate({ inputRange: [0, 1], outputRange: [still ? 0 : 520, 0] }) }],
    },
    icon: { transform: [{ scale: t.interpolate({ inputRange: [0, 0.65, 1], outputRange: still ? [1, 1, 1] : [0.6, 1.08, 1] }) }] },
  }), [t, still]);

  const w = wordsFor(kind);
  const who = String(company || '').trim();
  const whoName = who || 'this employer';
  const empty = mode === 'empty';
  // An empty sheet whose pass was already bought here: the button uses it, and sells nothing.
  const owned = empty && !!(pass && pass.available);
  const priceLabel = price || PRICE_LABEL_FALLBACK;
  // The one tap that survives `busy`, and only when the hook says the store has answered (see the header).
  const leavable = !busy || !!canCancel;
  const cancel = () => { if (leavable) onCancel(); };
  // A purchase still on its way: the words change, the offer never does.
  const settling = owned ? (payment || null) : null;
  const letter = kind === 'cover_letter';

  return (
    <Modal
      key={attempt}
      visible={open}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={cancel}
      onShow={() => { presented.current = true; }}
    >
      <View style={s.fill}>
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: motion.scrim }]} pointerEvents="none">
          <View style={s.scrim} />
        </Animated.View>
        {/* The backdrop is Cancel — except while a purchase is on its way. Not an accessibility element: the
            sheet's own Cancel is the reachable one. */}
        <Pressable style={StyleSheet.absoluteFill} onPress={cancel} accessible={false} />

        <Animated.View
          style={[s.sheet, { paddingBottom: insets.bottom + 10 }, motion.sheet]}
          accessibilityViewIsModal
        >
          <LinearGradient colors={SHEET_BG} locations={[0, 0.45, 1]} start={{ x: 0.2, y: 0 }} end={{ x: 0.8, y: 1 }} style={StyleSheet.absoluteFill} />
          <View style={s.grab} />

          {/* ⚠️ THE COPY SCROLLS, THE BUTTONS DO NOT: at any text size Continue and Cancel stay reachable. */}
          <ScrollView style={s.scroll} contentContainerStyle={s.scrollIn} alwaysBounceVertical={false} showsVerticalScrollIndicator={false}>
            <View style={s.headRow}>
              <Animated.View style={motion.icon}>
                {empty ? (
                  <View style={[s.icon, s.iconEmpty]}><Ionicons name="hourglass-outline" size={21} color={WARM} /></View>
                ) : (
                  <LinearGradient colors={[E.blue, E.purple]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.icon}>
                    <Ionicons name={w.icon} size={21} color="#fff" />
                  </LinearGradient>
                )}
              </Animated.View>
              <Text style={s.kicker} numberOfLines={1} maxFontSizeMultiplier={FONT_CAP.small}>{empty ? 'NONE LEFT' : w.kicker}</Text>
            </View>

            {empty ? (
              <Text style={s.title} accessibilityRole="header" maxFontSizeMultiplier={FONT_CAP.title}>{emptyTitle(kind, usage)}</Text>
            ) : who ? (
              <Title lead={w.lead} company={who} />
            ) : (
              <Title lead={w.bare} company="" />
            )}
            <Text style={s.body} maxFontSizeMultiplier={FONT_CAP.body}>
              {settling === 'approval'
                ? `Your payment is waiting to be approved. When it clears, your one-time pass generates this one for ${whoName}.`
                : settling === 'applying'
                  ? `Your payment went through. As soon as your one-time pass arrives, it generates this one for ${whoName}.`
                  : owned
                    ? `Your one-time pass is ready — use it to generate this one for ${whoName}.`
                    : empty
                      ? `Generate this one for ${whoName} once, or pick a plan for more every month.`
                      : `A ${letter ? 'cover letter written' : 'resume shaped'} for ${whoName} gives you a better chance of being selected.`}
            </Text>

            <View style={[s.benefits, empty && s.benefitsCompact]}>
              {benefitsFor(kind, whoName).map((b) => (
                <Benefit key={b.icon} icon={b.icon} title={b.title} sub={b.sub} compact={empty} />
              ))}
            </View>

            <UsageStrip kind={kind} mode={mode} who={whoName} usage={usage} pass={pass} />
          </ScrollView>

          {!!error && (
            <View style={s.note}>
              <Ionicons name="information-circle-outline" size={16} color={WARM} />
              <Text style={s.noteTx} maxFontSizeMultiplier={FONT_CAP.small}>{error}</Text>
            </View>
          )}

          <View style={s.actions}>
            {empty ? (
              <>
                <Primary
                  label={owned ? 'Use my one-time pass' : `Generate once — ${priceLabel}`}
                  sub={owned
                    ? (busy ? 'Checking your payment…' : settling === 'approval' ? 'Once your payment is approved' : 'You won’t be charged again')
                    : 'Includes the download'}
                  icon={owned ? 'ticket-outline' : 'flash'}
                  busy={busy}
                  onPress={onBuyOnce}
                  a11yLabel={owned
                    ? `Use my one-time pass for ${whoName}`
                    : `Generate once for ${priceLabel}. Includes the download`}
                  a11yHint={owned
                    ? (settling
                      ? 'Checks your payment and starts it as soon as your pass is here. Nothing new is bought.'
                      : 'Starts it with the pass you already bought. Nothing new is bought.')
                    : `Buys a one-time pass for ${whoName}, then starts it.`}
                />
                {!owned && (
                  <Text style={s.fine} maxFontSizeMultiplier={FONT_CAP.small}>
                    One payment covers {whoName}: one resume, one cover letter and their downloads. No subscription.
                  </Text>
                )}
                <Secondary
                  label="See plans" icon="diamond-outline" onPress={onSeePlans} disabled={busy}
                  a11yHint={`Opens the plans. Nothing is started for ${whoName}.`}
                />
              </>
            ) : (
              <Primary
                label="Continue"
                icon={w.icon}
                busy={busy}
                onPress={onContinue}
                a11yLabel={letter ? `Continue and write your cover letter for ${whoName}` : `Continue and tailor your resume for ${whoName}`}
                a11yHint={letter ? 'Starts writing it now.' : 'Starts tailoring it now.'}
              />
            )}
            <TouchableOpacity
              style={[s.cancel, !leavable && s.dim]} activeOpacity={0.7} onPress={cancel} disabled={!leavable}
              accessibilityRole="button" accessibilityLabel="Cancel"
              accessibilityHint={busy && canCancel
                ? 'Closes this. Nothing is started, and what you paid for stays yours.'
                : 'Closes this. Nothing is started.'}
              accessibilityState={{ disabled: !leavable }}
            >
              <Text style={s.cancelTx} maxFontSizeMultiplier={FONT_CAP.button}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, justifyContent: 'flex-end' },
  scrim: { flex: 1, backgroundColor: 'rgba(3,5,14,0.62)' },

  // overflow hidden: the gradient behind everything must follow the rounded top corners.
  sheet: {
    maxHeight: '92%', flexShrink: 1, paddingTop: 8, overflow: 'hidden',
    borderTopLeftRadius: 28, borderTopRightRadius: 28, backgroundColor: E.stage,
    borderWidth: 1, borderBottomWidth: 0, borderColor: 'rgba(255,255,255,0.12)',
  },
  grab: { alignSelf: 'center', width: 40, height: 4.5, borderRadius: 100, backgroundColor: 'rgba(255,255,255,0.26)', marginBottom: 4 },
  scroll: { flexGrow: 0, flexShrink: 1 },
  scrollIn: { paddingHorizontal: 18, paddingTop: 10, paddingBottom: 2 },

  headRow: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  icon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  iconEmpty: { backgroundColor: 'rgba(252,211,77,0.12)', borderWidth: 1, borderColor: 'rgba(252,211,77,0.38)' },
  kicker: { flexShrink: 1, fontSize: 10.5, fontWeight: '800', letterSpacing: 1.5, color: 'rgba(255,255,255,0.5)' },

  title: { marginTop: 12, fontSize: 22, fontWeight: '800', color: '#fff', letterSpacing: -0.5, lineHeight: 28 },
  titleSerif: { fontFamily: SERIF, fontStyle: 'italic', fontWeight: '400', letterSpacing: -0.2 },
  body: { marginTop: 6, fontSize: 13.5, fontWeight: '600', color: 'rgba(255,255,255,0.62)', lineHeight: 19 },

  benefits: { marginTop: 16, gap: 12 },
  benefitsCompact: { marginTop: 12, gap: 7 },
  benefit: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  benefitIcon: {
    width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    backgroundColor: E.glass, borderWidth: 1, borderColor: E.glassBorder,
  },
  benefitIconSm: { width: 26, height: 26, borderRadius: 9 },
  benefitTexts: { flex: 1, minWidth: 0 },
  benefitTitle: { fontSize: 14, fontWeight: '800', color: '#fff', letterSpacing: -0.2 },
  benefitSub: { marginTop: 2, fontSize: 12, fontWeight: '600', color: 'rgba(255,255,255,0.55)', lineHeight: 16 },

  strip: {
    marginTop: 16, padding: 13, borderRadius: 16,
    backgroundColor: 'rgba(94,234,212,0.07)', borderWidth: 1, borderColor: 'rgba(94,234,212,0.3)',
  },
  stripEmpty: { backgroundColor: 'rgba(252,211,77,0.06)', borderColor: 'rgba(252,211,77,0.3)' },
  stripRow: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  stripIcon: {
    width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    backgroundColor: 'rgba(7,10,24,0.45)', borderWidth: 1, borderColor: 'rgba(94,234,212,0.35)',
  },
  stripTexts: { flex: 1, minWidth: 0 },
  stripTitle: { fontSize: 14, fontWeight: '800', color: '#fff', letterSpacing: -0.2 },
  stripSub: { marginTop: 7, fontSize: 12, fontWeight: '600', color: 'rgba(255,255,255,0.58)', lineHeight: 16 },
  dots: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 10 },
  dot: { width: 13, height: 13, borderRadius: 7, backgroundColor: 'rgba(255,255,255,0.14)' },
  dotOn: { backgroundColor: E.mint },
  // The one Continue would use: ringed, so "uses one" can be seen as well as read.
  dotNext: { borderWidth: 2.5, borderColor: 'rgba(255,255,255,0.92)' },
  meter: { flexDirection: 'row', height: 8, borderRadius: 8, overflow: 'hidden', marginTop: 10, backgroundColor: 'rgba(255,255,255,0.12)' },
  meterOn: { backgroundColor: E.mint, borderRadius: 8 },

  note: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginHorizontal: 18, marginTop: 10, padding: 10,
    borderRadius: 12, backgroundColor: 'rgba(252,211,77,0.08)', borderWidth: 1, borderColor: 'rgba(252,211,77,0.26)',
  },
  noteTx: { flex: 1, fontSize: 12.5, fontWeight: '700', color: 'rgba(255,226,165,0.96)', lineHeight: 17 },

  actions: { paddingHorizontal: 18, paddingTop: 12, gap: 9 },
  // ⚠️ Shadow on the outer view, clipping on the inner gradient — the iOS trap Home's Tailor button notes.
  primaryWrap: {
    borderRadius: 16,
    shadowColor: E.blue, shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.42, shadowRadius: 20, elevation: 8,
  },
  primary: {
    minHeight: 54, paddingVertical: 9, paddingHorizontal: 16, borderRadius: 16, overflow: 'hidden',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
  },
  primaryTexts: { flexShrink: 1, alignItems: 'center' },
  primaryTx: { fontSize: 15.5, fontWeight: '800', color: '#fff', letterSpacing: -0.2, textAlign: 'center' },
  primarySub: { marginTop: 1, fontSize: 11.5, fontWeight: '700', color: 'rgba(255,255,255,0.82)', textAlign: 'center' },
  fine: { fontSize: 11.5, fontWeight: '600', color: 'rgba(255,255,255,0.5)', textAlign: 'center', lineHeight: 16, paddingHorizontal: 4 },
  secondary: {
    minHeight: 48, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: E.glass, borderWidth: 1, borderColor: E.glassBorder,
  },
  secondaryTx: { fontSize: 14.5, fontWeight: '700', color: 'rgba(255,255,255,0.9)', flexShrink: 1 },
  cancel: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  cancelTx: { fontSize: 14.5, fontWeight: '700', color: 'rgba(255,255,255,0.62)' },
  dim: { opacity: 0.5 },
});
