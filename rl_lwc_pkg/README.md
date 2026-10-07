# RL Picture Wedge — Lightning Web Component

Visual planned assortment workspace for the Ralph Lauren B2B demo.
Deployed alongside the `RL_Assortment_DataModel_SFDX` package.

## Component: rlPictureWedge

### Files

| File | Purpose |
|------|---------|
| `rlPictureWedge.js` | Controller — wire, state, drag-drop, actions |
| `rlPictureWedge.html` | Template — picture grid, data table, modals |
| `rlPictureWedge.css` | Styles — cards, drag states, table, badges |
| `rlPictureWedge.js-meta.xml` | Metadata — targets, exposed properties |
| `RLAssortmentController.cls` | Apex — queries, DML, token generation |
| `RLAssortmentControllerTest.cls` | Apex tests — 100% method coverage |

### Features

**Picture wedge view**
- Auto-generated grid from synced Anaplan data (sorted by Display_Sequence__c)
- Drag-and-drop card resequencing — writes back to Salesforce immediately
- Hero style ribbon + toggle (saves to Is_Hero_Override__c)
- Per-style annotation notes (saves to Sales_Rep_Note__c)
- Variance indicator (planned vs target), door count, delivery window
- Filter by: All / Hero styles / Tier A / Tier B / Tier C

**Data wedge view**
- Full tabular view of the same lines
- Inline note access, tier badges, door progress bar
- Totals footer row

**Buyer mode (Experience Cloud)**
- Read-only view — no drag, no hero toggle, no lock
- Buyer can mark each style: Approved / Flagged / Dropped
- Buyer status saves back to Buyer_Status__c

**Lock & share**
- "Share with buyer" generates a UUID token + Experience Cloud URL
- "Lock assortment" sets status=Locked, prevents further editing
- Status badge updates dynamically in the header

### Prerequisites

- Deploy `RL_Assortment_DataModel_SFDX.zip` first (custom objects must exist)
- API version 59.0+

### Deploy

```bash
# Authenticate
sf org login web --alias rl-sandbox --instance-url https://test.salesforce.com

# Deploy (objects must already exist from the data model package)
sf project deploy start --source-dir force-app --target-org rl-sandbox

# Run tests
sf apex run test --class-names RLAssortmentControllerTest --target-org rl-sandbox --result-format human
```

### Add to a Record Page

1. Open App Builder on the `RL_Assortment_Plan__c` record page
2. Find "RL Picture Wedge" in the Custom Components panel
3. Drag it onto the page layout
4. Set "Buyer mode" = false for internal sales pages
5. Save & Activate

### Add to Experience Cloud (Buyer Portal)

1. Open Experience Builder on your Experience Cloud site
2. Find "RL Picture Wedge" in components
3. Drag onto the buyer assortment page
4. Set "Buyer mode" = true
5. Pass the `recordId` via the URL parameter `planId` using a URL variable
6. Publish

### Sequence sync rule (IMPORTANT)

The Anaplan integration must NOT overwrite `Display_Sequence__c` after the
initial seed. Once Sofia has reordered the cards, her sequence is authoritative.

In your MuleSoft / BTP integration flow, add a conditional step:
```
IF Display_Sequence__c != null AND plan.Status__c != 'Draft'
THEN skip Display_Sequence__c update
ELSE write Display_Sequence__c from Anaplan merch_sequence
```

### Hero priority logic in LWC

The JS applies this rule when determining if a card shows the HERO ribbon:
```js
line.isHero = line.isHeroOverride || line.isHeroStyle
```
`Is_Hero_Override__c` (set by Sofia) takes precedence over `Is_Hero_Style__c`
(set by Anaplan). Sofia's curation is always the final word.
