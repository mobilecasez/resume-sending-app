// AI Hub — new feature. Safe to delete without affecting existing app.
//
// A signed-out preview of the employer Home, for LOOKING AT IT.
//
// The first build of that screen shipped a duplicate header and hard-edged rectangles across the
// hero — both instantly obvious on screen and both invisible to a type-check. This route renders
// the real component against fixtures so the design can be inspected in a simulator without an
// account, which is how those two were found and how the next one will be.
//
// Reachable only by deep link (cvapplyr://dev/home-preview) — nothing in the app links here.
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import EmployerHome from '../../components/employer-home/EmployerHome';
import { E } from '../../components/employer-home/theme';
import type { Target, HomeCard } from '../../services/employerHomeService';

// A page of "paper" that looks like a rendered resume at thumbnail size, as a data URI, so the
// carousel has something real-shaped to lay out without a server round-trip.
const paper = (accent: string) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="424" viewBox="0 0 300 424">
  <rect width="300" height="424" fill="#fff"/>
  <rect width="300" height="86" fill="${accent}"/>
  <circle cx="42" cy="43" r="20" fill="rgba(255,255,255,0.9)"/>
  <rect x="74" y="30" width="150" height="10" rx="4" fill="rgba(255,255,255,0.95)"/>
  <rect x="74" y="48" width="96" height="7" rx="3" fill="rgba(255,255,255,0.6)"/>
  ${[0, 1, 2].map((b) => `
    <rect x="22" y="${112 + b * 92}" width="66" height="7" rx="3" fill="${accent}"/>
    <rect x="22" y="${128 + b * 92}" width="256" height="6" rx="3" fill="#E7ECF4"/>
    <rect x="22" y="${142 + b * 92}" width="240" height="6" rx="3" fill="#E7ECF4"/>
    <rect x="22" y="${156 + b * 92}" width="200" height="6" rx="3" fill="#E7ECF4"/>
    <rect x="22" y="${170 + b * 92}" width="224" height="6" rx="3" fill="#EEF2F8"/>`).join('')}
  <rect x="22" y="392" width="60" height="14" rx="7" fill="${accent}22"/>
  <rect x="90" y="392" width="52" height="14" rx="7" fill="${accent}22"/>
  <rect x="150" y="392" width="70" height="14" rx="7" fill="${accent}22"/>
</svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
};

const TARGETS: Target[] = [
  { key: 't1', jobId: 'x1', company: 'iwell B.V.', role: 'Senior .NET Developer', initial: 'I', colors: ['#4F8DFF', '#7C6BFF'], match: 100, skills: ['.NET Core', 'Azure', 'React'], location: 'Amsterdam' },
  { key: 't2', jobId: 'x2', company: 'ONTEC', role: 'Senior .NET Engineer', initial: 'O', colors: ['#7C6BFF', '#DB2777'], match: 92, skills: ['C#', 'CI/CD'], location: 'Vienna' },
  { key: 't3', jobId: 'x3', company: 'Eneco', role: 'Platform Engineer', initial: 'E', colors: ['#10B981', '#06B6D4'], match: 78, skills: ['Azure', 'SAP'], location: 'Rotterdam' },
];
const CARDS: HomeCard[] = [
  { id: 'banner', name: 'Bold Banner', accent: '#1d4ed8', image: paper('#1d4ed8') },
  { id: 'rightrail', name: 'Right Rail', accent: '#0f766e', image: paper('#0f766e') },
  { id: 'elegant', name: 'Elegant Serif', accent: '#7f1d1d', image: paper('#7f1d1d') },
  { id: 'timeline', name: 'Career Timeline', accent: '#ea580c', image: paper('#ea580c') },
];

export default function HomePreview() {
  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.fill}>
        <EmployerHome
          firstName="Rishi"
          unreadCount={9}
          onOpenDashboard={() => {}}
          onOpenMenu={() => {}}
          onOpenNotifications={() => {}}
          loaders={{
            targets: async () => TARGETS,
            cards: async () => ({ preferred: 'banner', cards: CARDS }),
            paid: async () => false,
          }}
        />
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: E.stage },
  fill: { flex: 1, backgroundColor: E.bg },
});
