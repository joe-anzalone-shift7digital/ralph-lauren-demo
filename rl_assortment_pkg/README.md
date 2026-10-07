# RL Assortment Data Model — Salesforce Metadata Package

Deploys the complete Planned Assortment data model to a Salesforce org.
Built for the Ralph Lauren B2B Commerce Platform demo.

## Objects deployed

| Object API Name               | Label                  | Type          | Purpose |
|-------------------------------|------------------------|---------------|---------|
| `RL_Assortment_Plan__c`       | Assortment Plan        | Custom        | One per account per season. Top-level container. |
| `RL_Assortment_Line__c`       | Assortment Line Item   | Custom        | One per style per plan. Core data row. |
| `RL_Size_Run__c`              | Size Run               | Custom        | Unit breakdown by size per line item. |
| `RL_Door_Distribution__c`     | Door Distribution      | Custom        | Door-level allocation per style. |
| `RL_Anaplan_Sync_Log__c`      | Anaplan Sync Log       | Custom        | Audit trail of every Anaplan sync event. |
| `Product2`                    | Product                | Standard + Ext| RL custom fields added to standard Product object. |

## Permission sets deployed

| Name                          | Assigned to |
|-------------------------------|-------------|
| `RL_Assortment_Admin`         | Integration service accounts, system admins |
| `RL_Assortment_SalesRep`      | Sales reps (Sofia persona) |

## Prerequisites

- Salesforce CLI (sf) installed: https://developer.salesforce.com/tools/salesforcecli
- An authenticated org alias (sandbox or scratch org recommended for first deploy)

## Deploy — option 1: SFDX source deploy (recommended)

```bash
# 1. Authenticate to your org (opens browser login)
sf org login web --alias my-rl-sandbox --instance-url https://test.salesforce.com

# 2. From the package root directory, deploy all metadata
sf project deploy start --source-dir force-app --target-org my-rl-sandbox

# 3. Assign permission sets to yourself for testing
sf org assign permset --name RL_Assortment_Admin --target-org my-rl-sandbox

# 4. Verify deployment
sf project deploy report --target-org my-rl-sandbox
```

## Deploy — option 2: Convert to metadata API format and deploy as zip

```bash
# Convert source format to metadata API format
sf project convert source --root-dir force-app --output-dir mdapi_output

# Deploy via metadata API
sf project deploy start --metadata-dir mdapi_output --target-org my-rl-sandbox
```

## Deploy — option 3: Deploy via workbench (no CLI required)

1. Zip the `force-app` folder contents
2. Go to https://workbench.developerforce.com
3. Migration > Deploy
4. Upload the zip and click Deploy

## Post-deploy steps

1. Assign `RL_Assortment_Admin` to your integration user (the one MuleSoft/BTP will use for the Anaplan sync)
2. Assign `RL_Assortment_SalesRep` to sales rep users
3. Add the new objects to relevant App pages in App Builder
4. Configure field-level security per profile as required
5. Set up the Anaplan integration to upsert using:
   - `Anaplan_Plan_ID__c` as external ID on `RL_Assortment_Plan__c`
   - `Anaplan_Material_ID__c` as external ID on `RL_Assortment_Line__c` (combined with Plan ID)
   - `Anaplan_Size_ID__c` as external ID on `RL_Size_Run__c`
   - `Anaplan_Door_ID__c` as external ID on `RL_Door_Distribution__c`

## Key design decisions

### Display_Sequence__c sync rule
The `Display_Sequence__c` field on `RL_Assortment_Line__c` is seeded from Anaplan's
`merch_sequence` on the FIRST sync only. After that, the integration must NOT overwrite
this field — it is owned by Sofia (the sales rep). Use a sync flag or check
`Display_Sequence__c != null` before writing.

### Hero override logic
The LWC should apply this priority rule:
`IF Is_Hero_Override__c = TRUE → show as hero`
`ELSE IF Is_Hero_Style__c = TRUE → show as hero`
`ELSE → standard style`

### Sequence preservation on plan updates
When Anaplan pushes style adds/drops mid-season, new styles should receive a
`Display_Sequence__c` value at the end of the current sequence (max + 1).
Dropped styles should be soft-deleted or flagged inactive rather than hard-deleted,
to preserve Sofia's sequence numbering.
