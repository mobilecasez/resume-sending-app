# Credits System - Mobile App UI Reference

## Screen Hierarchy

```
App Navigation
├── Dashboard/Settings
│   └── 💳 Usage & Credits (New)
│       ├── Usage Statistics Screen
│       │   ├── Credit Balance Card
│       │   ├── Current Month Usage
│       │   ├── Historical Usage
│       │   └── Action Buttons
│       │       ├── → Plans Screen
│       │       └── → Purchase History Screen
│       ├── Plans Screen
│       │   ├── Current Balance Badge
│       │   ├── Plan Cards (4 plans)
│       │   └── How Credits Work Info
│       └── Purchase History Screen
│           └── Transaction List
```

---

## UsageScreen Layout

```
┌──────────────────────────────────────┐
│ [← Back]      Usage & Credits        │ ← Blue Header
│ Track your cover letter generation   │
├──────────────────────────────────────┤
│                                      │
│  ┌────────────────────────────────┐ │
│  │ 💳 Credits Balance   [+ Buy]   │ │
│  │                                │ │
│  │           30                   │ │ ← Large Number
│  │    Credits Remaining           │ │
│  │                                │ │
│  │  Expires: Feb 21, 2026         │ │ ← Expiry Badge
│  └────────────────────────────────┘ │
│                                      │
│  ┌────────────────────────────────┐ │
│  │ 📊 January 2026 Usage          │ │
│  │                                │ │
│  │ Credits Used This Month        │ │
│  │ 5 / 30                         │ │
│  │ ▓▓▓▓▓░░░░░░░░░░░░░░░░░         │ │ ← Progress Bar
│  │ 17% used                       │ │
│  │                                │ │
│  │ ┌───────────┐  ┌──────────┐   │ │
│  │ │     5     │  │    3     │   │ │
│  │ │ Generated │  │   Sent   │   │ │ ← Stats Grid
│  │ └───────────┘  └──────────┘   │ │
│  └────────────────────────────────┘ │
│                                      │
│  ┌────────────────────────────────┐ │
│  │ 📈 Usage History               │ │
│  │                                │ │
│  │ Dec 2025          10 credits   │ │
│  │ 10 generated • 8 sent          │ │
│  │                                │ │
│  │ Nov 2025          15 credits   │ │
│  │ 15 generated • 12 sent         │ │
│  └────────────────────────────────┘ │
│                                      │
│  ┌────────────────────────────────┐ │
│  │  View Plans & Pricing          │ │ ← Action Buttons
│  └────────────────────────────────┘ │
│  ┌────────────────────────────────┐ │
│  │  Purchase History              │ │
│  └────────────────────────────────┘ │
│                                      │
└──────────────────────────────────────┘
```

### Color Scheme:
- **Header**: Blue (#007AFF)
- **Cards**: White (#FFFFFF) with subtle shadows
- **Credit Count**: Large blue (#007AFF)
- **Progress Bar**: Blue fill (#007AFF), gray background
- **Action Buttons**: Blue (#007AFF), white border for secondary
- **Warning**: Orange (#FF9500) for expiring soon, Red (#FF3B30) for expired

---

## PlansScreen Layout

```
┌──────────────────────────────────────┐
│ [← Back]    Choose Your Plan         │ ← Blue Header
│ Generate professional cover letters  │
├──────────────────────────────────────┤
│                                      │
│  ┌────────────────────────────────┐ │
│  │    Current Balance             │ │ ← Elevated Card
│  │         30 credits             │ │
│  │  Expires: Feb 21, 2026         │ │
│  └────────────────────────────────┘ │
│                                      │
│  ┌────────────────────────────────┐ │
│  │  Starter                       │ │
│  │  $ 4.99                        │ │
│  │  10 Credits                    │ │
│  │  Valid for 30 days             │ │
│  │                                │ │
│  │  ✓ 10 cover letters            │ │
│  │  ✓ 30 days validity            │ │
│  │  ✓ AI-powered generation       │ │
│  │                                │ │
│  │  [  Purchase Plan  ]           │ │
│  │  $0.50 per credit              │ │
│  └────────────────────────────────┘ │
│                                      │
│  ┌────────────────────────────────┐ │
│  │  ⭐ MOST POPULAR               │ │ ← Green Badge
│  │  Professional                  │ │
│  │  $ 12.99                       │ │
│  │  30 Credits                    │ │
│  │  Valid for 30 days             │ │
│  │                                │ │
│  │  ✓ 30 cover letters            │ │
│  │  ✓ 30 days validity            │ │
│  │  ✓ AI-powered generation       │ │
│  │  ✓ Priority support            │ │
│  │                                │ │
│  │  [  Get Started  ]             │ │ ← Green Button
│  │  $0.43 per credit              │ │
│  └────────────────────────────────┘ │
│                                      │
│  ┌────────────────────────────────┐ │
│  │  Premium                       │ │
│  │  $ 34.99                       │ │
│  │  100 Credits                   │ │
│  │  Valid for 90 days             │ │
│  │                                │ │
│  │  ✓ 100 cover letters           │ │
│  │  ✓ 90 days validity            │ │
│  │  ✓ Extended validity           │ │
│  │                                │ │
│  │  [  Purchase Plan  ]           │ │
│  │  $0.35 per credit              │ │
│  └────────────────────────────────┘ │
│                                      │
│  ┌────────────────────────────────┐ │
│  │  Enterprise                    │ │
│  │  $ 149.99                      │ │
│  │  500 Credits                   │ │
│  │  Valid for 365 days            │ │
│  │                                │ │
│  │  ✓ 500 cover letters           │ │
│  │  ✓ Annual validity             │ │
│  │  ✓ All features included       │ │
│  │                                │ │
│  │  [  Purchase Plan  ]           │ │
│  │  $0.30 per credit              │ │
│  └────────────────────────────────┘ │
│                                      │
│  ┌────────────────────────────────┐ │
│  │  💡 How Credits Work           │ │
│  │                                │ │
│  │  • 1 cover letter = 1 credit  │ │
│  │  • Valid for specified days   │ │
│  │  • AI-powered personalization │ │
│  └────────────────────────────────┘ │
│                                      │
└──────────────────────────────────────┘
```

### Purchase Confirmation Dialog:
```
┌─────────────────────────────────┐
│   Confirm Purchase              │
│                                 │
│   Purchase 30 credits for      │
│   $12.99?                       │
│                                 │
│   Valid for 30 days.            │
│                                 │
│   [Cancel]    [Purchase]        │
└─────────────────────────────────┘
```

### Success Dialog:
```
┌─────────────────────────────────┐
│   Purchase Successful! 🎉       │
│                                 │
│   30 credits have been added    │
│   to your account.              │
│                                 │
│   Remaining: 30 credits         │
│   Expires: Feb 21, 2026         │
│                                 │
│   [OK]                          │
└─────────────────────────────────┘
```

---

## PurchaseHistoryScreen Layout

```
┌──────────────────────────────────────┐
│ [← Back]    Purchase History         │ ← Blue Header
│ Your credit purchase transactions    │
├──────────────────────────────────────┤
│                                      │
│  ┌────────────────────────────────┐ │
│  │  Professional      $ 12.99     │ │
│  │  [✓ completed]                 │ │ ← Green Badge
│  │                                │ │
│  │  Credits: 30                   │ │
│  │  Date: Jan 22, 2026 10:30 AM   │ │
│  │  Valid From: Jan 22, 2026      │ │
│  │  Valid Until: Feb 21, 2026     │ │
│  │  Method: simulated             │ │
│  │  Transaction ID: TEST-1234567  │ │
│  └────────────────────────────────┘ │
│                                      │
│  ┌────────────────────────────────┐ │
│  │  Starter           $ 4.99      │ │
│  │  [✓ completed]                 │ │
│  │                                │ │
│  │  Credits: 10                   │ │
│  │  Date: Jan 15, 2026 2:15 PM    │ │
│  │  Valid From: Jan 15, 2026      │ │
│  │  Valid Until: Feb 14, 2026     │ │
│  │  Method: simulated             │ │
│  │  Transaction ID: TEST-7654321  │ │
│  └────────────────────────────────┘ │
│                                      │
└──────────────────────────────────────┘
```

### Empty State:
```
┌──────────────────────────────────────┐
│ [← Back]    Purchase History         │
├──────────────────────────────────────┤
│                                      │
│                                      │
│              📦                      │
│                                      │
│       No Purchases Yet               │
│                                      │
│   Your purchase history will         │
│   appear here once you buy a plan.   │
│                                      │
│                                      │
└──────────────────────────────────────┘
```

---

## Interaction Flows

### Flow 1: Purchase Credits

```
Dashboard
    ↓ [Tap "Usage & Credits"]
UsageScreen
    ↓ [Tap "+ Buy Credits"]
PlansScreen
    ↓ [Tap "Purchase" on a plan]
Confirmation Dialog
    ↓ [Tap "Purchase"]
Processing...
    ↓
Success Dialog
    ↓ [Tap "OK"]
UsageScreen (updated balance)
```

### Flow 2: Check Usage

```
Dashboard
    ↓ [Tap "Usage & Credits"]
UsageScreen
    ↓ [View credit balance]
    ↓ [View monthly usage]
    ↓ [View history]
    ↓ [Pull down to refresh]
Updated Data Displayed
```

### Flow 3: View Purchase History

```
UsageScreen
    ↓ [Tap "Purchase History"]
PurchaseHistoryScreen
    ↓ [View transactions]
    ↓ [Pull down to refresh]
Updated Data Displayed
```

### Flow 4: Generate with Credits

```
Generate Screen
    ↓ [Tap "Generate"]
Check Credits...
    ↓ [If insufficient]
Error: "Insufficient Credits"
    ↓ [Button: "Buy Credits"]
PlansScreen
    ↓ [Purchase plan]
Generate Screen
    ↓ [Generate successfully]
Credits Deducted
    ↓
UsageScreen (updated: -1 credit)
```

---

## Warning States

### Low Credits (< 5 remaining):
```
┌────────────────────────────────┐
│ ⚠️ You're running low on       │
│    credits! Consider           │
│    purchasing more.            │
└────────────────────────────────┘
```

### Expiring Soon (< 7 days):
```
┌────────────────────────────────┐
│ ⚠️ Your credits expire in      │
│    3 days! Purchase a new      │
│    plan to continue.           │
└────────────────────────────────┘
```

### Expired:
```
┌────────────────────────────────┐
│ ❌ Your credits have expired.  │
│    Purchase a new plan to      │
│    generate cover letters.     │
└────────────────────────────────┘
```

### No Credits:
```
┌────────────────────────────────┐
│ ⚠️ You're out of credits!      │
│    Purchase a plan to          │
│    continue generating.        │
└────────────────────────────────┘
```

---

## Responsive Behavior

### Loading States:
- Show ActivityIndicator with "Loading..." text
- Centered on screen
- Blue spinner color

### Error States:
- Red border on left side
- Red text for error message
- "Retry" button in red
- Appears below header

### Pull-to-Refresh:
- All list screens support pull-to-refresh
- Spinner appears at top
- Refreshes data from server

### Empty States:
- Large emoji icon (📦, 💳, etc.)
- Title text
- Descriptive subtext
- Centered on screen

---

## Accessibility Features

### Text Sizes:
- Headers: 28-32pt
- Titles: 18-20pt
- Body: 14-16pt
- Small text: 12pt

### Touch Targets:
- Buttons: Minimum 44pt height
- Cards: Full-width, easy to tap
- Sufficient spacing between elements

### Color Contrast:
- Blue (#007AFF) on white - High contrast
- Black (#1A1A1A) on white - High contrast
- Warning colors (orange/red) - High contrast

### Visual Feedback:
- Buttons show pressed state
- Loading indicators for async operations
- Success/error messages with icons
- Progress bars for visual representation

---

## Platform-Specific Considerations

### iOS:
- Uses iOS-style navigation bars
- Blue accent color (#007AFF)
- System fonts (San Francisco)
- Pull-to-refresh with native spinner

### Android:
- Material Design principles
- Ripple effect on buttons
- Elevation shadows on cards
- Pull-to-refresh with material spinner

---

## Summary

The mobile UI follows these principles:
- ✅ Clean, modern design
- ✅ Clear visual hierarchy
- ✅ Obvious call-to-actions
- ✅ Informative without clutter
- ✅ Consistent color scheme
- ✅ Responsive and interactive
- ✅ Accessible and user-friendly

All screens are ready to integrate into your existing app navigation!
