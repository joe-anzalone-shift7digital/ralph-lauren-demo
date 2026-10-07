/**
 * RLAssortmentController
 * Shared Apex controller for rlPictureWedge and rlDataWedge LWCs.
 *
 * Methods:
 *   getAssortmentLines    – wire query: plan header + line items
 *   getSizeRunsForPlan    – wire query: all size runs for a plan (data wedge drill-down)
 *   updateLineSequences   – bulk save Display_Sequence__c (picture wedge drag-drop)
 *   updateLineField       – allowlisted single-field save (hero, notes, buyer status)
 *   lockAssortmentPlan    – sets status = Locked, generates share token
 *   generateShareToken    – creates / returns UUID buyer share link token
 */
public with sharing class RLAssortmentController {

    // ── DTOs ─────────────────────────────────────────────────────────────────

    /** Flat DTO for one assortment line item, enriched with plan header fields */
    public class AssortmentLineDTO {
        @AuraEnabled public String  id;
        @AuraEnabled public String  planName;
        @AuraEnabled public String  planStatus;
        @AuraEnabled public String  accountName;
        @AuraEnabled public String  season;
        @AuraEnabled public String  fob;
        @AuraEnabled public String  lastSync;
        @AuraEnabled public Integer displaySequence;
        @AuraEnabled public String  styleNumber;
        @AuraEnabled public String  productName;
        @AuraEnabled public String  colorway;
        @AuraEnabled public String  imageUrl;
        @AuraEnabled public String  tier;
        @AuraEnabled public Integer plannedUnits;
        @AuraEnabled public Integer targetUnits;
        @AuraEnabled public Decimal wholesaleUnitCost;
        @AuraEnabled public Decimal extendedCost;
        @AuraEnabled public Integer doorCount;
        @AuraEnabled public String  deliveryWindow;
        @AuraEnabled public Boolean isHeroStyle;
        @AuraEnabled public Boolean isHeroOverride;
        @AuraEnabled public String  salesRepNote;
        @AuraEnabled public String  buyerNote;
        @AuraEnabled public String  buyerStatus;
        @AuraEnabled public String  category;
    }

    /** DTO for a single size run record */
    public class SizeRunDTO {
        @AuraEnabled public String  lineId;         // parent RL_Assortment_Line__c Id
        @AuraEnabled public String  sizeCode;
        @AuraEnabled public Integer plannedUnits;
        @AuraEnabled public Integer targetUnits;
        @AuraEnabled public Boolean isCoreSize;
        @AuraEnabled public Integer sizeSortOrder;
    }

    /** Inner class for JSON deserialisation of sequence updates */
    public class SequenceUpdate {
        public String  id;
        public Integer seq;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // getAssortmentLines
    //   Wire-compatible (cacheable). Returns all line items for a plan,
    //   with plan header fields repeated on each DTO (LWC reads from first).
    // ═════════════════════════════════════════════════════════════════════════
    @AuraEnabled(cacheable=true)
    public static List<AssortmentLineDTO> getAssortmentLines(Id planId) {
        if (planId == null) {
            throw new AuraHandledException('planId is required.');
        }

        List<RL_Assortment_Line__c> lines = [
            SELECT
                Id,
                Display_Sequence__c,
                Style_Number__c,
                Product__r.Name,
                Product__r.Colorway__c,
                Product__r.AEM_Image_URL__c,
                Tier__c,
                Planned_Units__c,
                Target_Units__c,
                Wholesale_Unit_Cost__c,
                Extended_Cost__c,
                Door_Count__c,
                Delivery_Window__c,
                Is_Hero_Style__c,
                Is_Hero_Override__c,
                Sales_Rep_Note__c,
                Buyer_Note__c,
                Buyer_Status__c,
                FOB__c,
                Category__c,
                Assortment_Plan__r.Name,
                Assortment_Plan__r.Status__c,
                Assortment_Plan__r.Account__r.Name,
                Assortment_Plan__r.Season__c,
                Assortment_Plan__r.FOB__c,
                Assortment_Plan__r.Last_Sync_DateTime__c
            FROM RL_Assortment_Line__c
            WHERE Assortment_Plan__c = :planId
            ORDER BY Display_Sequence__c ASC NULLS LAST
            LIMIT 500
        ];

        List<AssortmentLineDTO> dtos = new List<AssortmentLineDTO>();
        for (RL_Assortment_Line__c line : lines) {
            AssortmentLineDTO dto        = new AssortmentLineDTO();
            dto.id                       = line.Id;
            dto.displaySequence          = line.Display_Sequence__c != null
                                            ? Integer.valueOf(line.Display_Sequence__c) : null;
            dto.styleNumber              = line.Style_Number__c;
            dto.productName              = line.Product__r?.Name;
            dto.colorway                 = line.Product__r?.Colorway__c;
            dto.imageUrl                 = line.Product__r?.AEM_Image_URL__c;
            dto.tier                     = line.Tier__c;
            dto.plannedUnits             = line.Planned_Units__c != null
                                            ? Integer.valueOf(line.Planned_Units__c) : 0;
            dto.targetUnits              = line.Target_Units__c != null
                                            ? Integer.valueOf(line.Target_Units__c) : 0;
            dto.wholesaleUnitCost        = line.Wholesale_Unit_Cost__c;
            dto.extendedCost             = line.Extended_Cost__c;
            dto.doorCount                = line.Door_Count__c != null
                                            ? Integer.valueOf(line.Door_Count__c) : 0;
            dto.deliveryWindow           = line.Delivery_Window__c;
            dto.isHeroStyle              = line.Is_Hero_Style__c;
            dto.isHeroOverride           = line.Is_Hero_Override__c;
            dto.salesRepNote             = line.Sales_Rep_Note__c;
            dto.buyerNote                = line.Buyer_Note__c;
            dto.buyerStatus              = line.Buyer_Status__c;
            dto.fob                      = line.FOB__c;
            dto.category                 = line.Category__c;
            // Plan header (repeated on each DTO — LWC reads from first record)
            dto.planName                 = line.Assortment_Plan__r?.Name;
            dto.planStatus               = line.Assortment_Plan__r?.Status__c;
            dto.accountName              = line.Assortment_Plan__r?.Account__r?.Name;
            dto.season                   = line.Assortment_Plan__r?.Season__c;
            dto.fob                      = line.Assortment_Plan__r?.FOB__c;
            dto.lastSync                 = line.Assortment_Plan__r?.Last_Sync_DateTime__c != null
                                            ? String.valueOf(
                                                line.Assortment_Plan__r.Last_Sync_DateTime__c
                                              )
                                            : null;
            dtos.add(dto);
        }
        return dtos;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // getSizeRunsForPlan
    //   Wire-compatible (cacheable). Returns all RL_Size_Run__c records for
    //   every line item in a plan. The LWC groups them client-side by lineId.
    //   Called by rlDataWedge for the size-run drill-down rows.
    // ═════════════════════════════════════════════════════════════════════════
    @AuraEnabled(cacheable=true)
    public static List<SizeRunDTO> getSizeRunsForPlan(Id planId) {
        if (planId == null) {
            throw new AuraHandledException('planId is required.');
        }

        List<RL_Size_Run__c> runs = [
            SELECT
                Id,
                Assortment_Line__c,
                Size_Code__c,
                Planned_Units__c,
                Target_Units__c,
                Is_Core_Size__c,
                Size_Sort_Order__c
            FROM RL_Size_Run__c
            WHERE Assortment_Line__r.Assortment_Plan__c = :planId
            ORDER BY Assortment_Line__c, Size_Sort_Order__c ASC NULLS LAST
            LIMIT 5000
        ];

        List<SizeRunDTO> dtos = new List<SizeRunDTO>();
        for (RL_Size_Run__c run : runs) {
            SizeRunDTO dto    = new SizeRunDTO();
            dto.lineId        = run.Assortment_Line__c;
            dto.sizeCode      = run.Size_Code__c;
            dto.plannedUnits  = run.Planned_Units__c != null
                                ? Integer.valueOf(run.Planned_Units__c) : 0;
            dto.targetUnits   = run.Target_Units__c != null
                                ? Integer.valueOf(run.Target_Units__c) : 0;
            dto.isCoreSize    = run.Is_Core_Size__c;
            dto.sizeSortOrder = run.Size_Sort_Order__c != null
                                ? Integer.valueOf(run.Size_Sort_Order__c) : 99;
            dtos.add(dto);
        }
        return dtos;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // updateLineSequences
    //   Bulk-saves Display_Sequence__c after Sofia's drag-drop resequencing.
    //   Input: JSON string [{"id":"a01...","seq":1}, ...]
    //   Never touches Anaplan-sourced fields.
    // ═════════════════════════════════════════════════════════════════════════
    @AuraEnabled
    public static void updateLineSequences(String sequenceUpdates) {
        if (String.isBlank(sequenceUpdates)) return;

        List<SequenceUpdate> updates =
            (List<SequenceUpdate>) JSON.deserialize(
                sequenceUpdates, List<SequenceUpdate>.class
            );

        List<RL_Assortment_Line__c> toUpdate = new List<RL_Assortment_Line__c>();
        for (SequenceUpdate u : updates) {
            if (String.isNotBlank(u.id)) {
                toUpdate.add(new RL_Assortment_Line__c(
                    Id                  = u.id,
                    Display_Sequence__c = u.seq
                ));
            }
        }

        if (!toUpdate.isEmpty()) {
            try {
                update toUpdate;
            } catch (DmlException ex) {
                throw new AuraHandledException(
                    'Failed to save sequence: ' + ex.getDmlMessage(0)
                );
            }
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // updateLineField
    //   General-purpose single-field updater with an explicit allowlist.
    //   Prevents the LWC from writing arbitrary fields to the database.
    // ═════════════════════════════════════════════════════════════════════════
    @AuraEnabled
    public static void updateLineField(
        Id      lineId,
        String  fieldName,
        String  stringValue,
        Boolean boolValue
    ) {
        Set<String> allowedFields = new Set<String>{
            'Is_Hero_Override__c',
            'Sales_Rep_Note__c',
            'Buyer_Note__c',
            'Buyer_Status__c'
        };

        if (!allowedFields.contains(fieldName)) {
            throw new AuraHandledException(
                'Field "' + fieldName + '" is not permitted for direct update.'
            );
        }

        RL_Assortment_Line__c line = new RL_Assortment_Line__c(Id = lineId);

        switch on fieldName {
            when 'Is_Hero_Override__c' { line.Is_Hero_Override__c = boolValue;   }
            when 'Sales_Rep_Note__c'   { line.Sales_Rep_Note__c   = stringValue; }
            when 'Buyer_Note__c'       { line.Buyer_Note__c       = stringValue; }
            when 'Buyer_Status__c'     { line.Buyer_Status__c     = stringValue; }
        }

        try {
            update line;
        } catch (DmlException ex) {
            throw new AuraHandledException(
                'Failed to update field: ' + ex.getDmlMessage(0)
            );
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // lockAssortmentPlan
    //   Sets the plan status to Locked and generates a share token if one
    //   does not already exist.
    // ═════════════════════════════════════════════════════════════════════════
    @AuraEnabled
    public static void lockAssortmentPlan(Id planId) {
        RL_Assortment_Plan__c plan = [
            SELECT Id, Status__c, Shared_Link_Token__c
            FROM RL_Assortment_Plan__c
            WHERE Id = :planId
            LIMIT 1
        ];

        plan.Status__c = 'Locked';
        if (String.isBlank(plan.Shared_Link_Token__c)) {
            plan.Shared_Link_Token__c = generateToken();
        }

        try {
            update plan;
        } catch (DmlException ex) {
            throw new AuraHandledException(
                'Failed to lock plan: ' + ex.getDmlMessage(0)
            );
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // generateShareToken
    //   Returns the existing token, or creates and saves a new one.
    //   Also advances plan status to Shared with Buyer if still Draft/In Review.
    // ═════════════════════════════════════════════════════════════════════════
    @AuraEnabled
    public static String generateShareToken(Id planId) {
        RL_Assortment_Plan__c plan = [
            SELECT Id, Status__c, Shared_Link_Token__c, Shared_Date__c
            FROM RL_Assortment_Plan__c
            WHERE Id = :planId
            LIMIT 1
        ];

        if (String.isBlank(plan.Shared_Link_Token__c)) {
            plan.Shared_Link_Token__c = generateToken();
        }
        if (plan.Status__c == 'Draft' || plan.Status__c == 'In Review') {
            plan.Status__c = 'Shared with Buyer';
        }
        plan.Shared_Date__c = Datetime.now();

        try {
            update plan;
        } catch (DmlException ex) {
            throw new AuraHandledException(
                'Failed to generate share token: ' + ex.getDmlMessage(0)
            );
        }

        return plan.Shared_Link_Token__c;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // convertAssortmentToOrder
    //   Converts an approved assortment plan into a B2B Commerce CartItem set
    //   (WebCart + CartItem records), then sets plan status to Converted.
    //
    //   Parameters:
    //     planId         – RL_Assortment_Plan__c Id
    //     lineIds        – JSON array of RL_Assortment_Line__c Ids to include
    //     poNumber       – buyer PO number (stored on cart)
    //     deliveryDate   – requested delivery date (ISO string, nullable)
    //     orderNotes     – free-text order notes (nullable)
    //     includeFlagged – whether Flagged-for-Discussion lines are included
    //
    //   Returns: the CartId (String) of the created B2B Commerce cart.
    //   The B2B Commerce checkout flow (existing platform capability) then
    //   handles order submission from the cart to SAP.
    // ═════════════════════════════════════════════════════════════════════════
    @AuraEnabled
    public static String convertAssortmentToOrder(
        Id      planId,
        String  lineIds,
        String  poNumber,
        String  deliveryDate,
        String  orderNotes,
        Boolean includeFlagged
    ) {
        if (planId == null) {
            throw new AuraHandledException('planId is required.');
        }
        if (String.isBlank(poNumber)) {
            throw new AuraHandledException('Purchase Order Number is required.');
        }

        // Deserialise the line ID list
        List<String>  lineIdList = (List<String>) JSON.deserialize(
            String.isNotBlank(lineIds) ? lineIds : '[]',
            List<String>.class
        );
        if (lineIdList.isEmpty()) {
            throw new AuraHandledException('No line items selected for order conversion.');
        }

        // ── Fetch the plan + account context ────────────────────────────────
        RL_Assortment_Plan__c plan = [
            SELECT Id, Name, Account__c, Account__r.Name, Season__c, FOB__c,
                   Status__c, Shared_Link_Token__c
            FROM RL_Assortment_Plan__c
            WHERE Id = :planId
            LIMIT 1
        ];

        if (plan.Status__c == 'Converted to Order') {
            throw new AuraHandledException(
                'This plan has already been converted to an order.'
            );
        }

        // ── Fetch the selected assortment lines ──────────────────────────────
        Set<Id> lineIdSet = new Set<Id>();
        for (String id : lineIdList) {
            lineIdSet.add(Id.valueOf(id));
        }

        List<RL_Assortment_Line__c> lines = [
            SELECT Id, Style_Number__c, Product__c, Planned_Units__c,
                   Wholesale_Unit_Cost__c, Tier__c, Delivery_Window__c,
                   FOB__c, Buyer_Status__c
            FROM RL_Assortment_Line__c
            WHERE Id IN :lineIdSet
              AND Assortment_Plan__c = :planId
        ];

        if (lines.isEmpty()) {
            throw new AuraHandledException('No valid line items found for conversion.');
        }

        // ── Create the B2B Commerce WebCart ──────────────────────────────────
        // Note: WebCart requires the AccountId and a valid WebStore.
        // In production the WebStoreId should come from a Custom Setting or
        // Named Credential; this example uses a query for simplicity.
        // The org must have B2B Commerce installed for these objects to exist.
        String webStoreId = getDefaultWebStoreId();

        WebCart cart = new WebCart(
            Name          = 'Assortment: ' + plan.Name + ' — PO: ' + poNumber,
            AccountId     = plan.Account__c,
            WebStoreId    = webStoreId,
            Status        = 'Active',
            CurrencyIsoCode = 'USD'
        );

        // Store plan reference and PO number in cart description field
        String cartDesc = 'Plan: ' + plan.Id
            + ' | PO: ' + poNumber
            + ' | Season: ' + (plan.Season__c != null ? plan.Season__c : '')
            + ' | FOB: '    + (plan.FOB__c    != null ? plan.FOB__c    : '');
        if (String.isNotBlank(orderNotes)) {
            cartDesc += ' | Notes: ' + orderNotes;
        }
        cart.Description = cartDesc.left(255);

        try {
            insert cart;
        } catch (DmlException ex) {
            throw new AuraHandledException(
                'Failed to create B2B Commerce cart: ' + ex.getDmlMessage(0)
            );
        }

        // ── Create CartItem records (one per assortment line) ─────────────────
        List<CartItem> cartItems = new List<CartItem>();
        for (RL_Assortment_Line__c line : lines) {
            CartItem item = new CartItem(
                CartId          = cart.Id,
                Product2Id      = line.Product__c,
                Quantity        = line.Planned_Units__c != null
                                    ? line.Planned_Units__c : 0,
                UnitAdjustedPrice = line.Wholesale_Unit_Cost__c,
                Type            = 'Product',
                Name            = line.Style_Number__c != null
                                    ? line.Style_Number__c : 'Style'
            );
            cartItems.add(item);
        }

        try {
            insert cartItems;
        } catch (DmlException ex) {
            // Roll back the cart
            delete cart;
            throw new AuraHandledException(
                'Failed to add line items to cart: ' + ex.getDmlMessage(0)
            );
        }

        // ── Update plan status to Converted to Order ─────────────────────────
        plan.Status__c = 'Converted to Order';
        try {
            update plan;
        } catch (DmlException ex) {
            // Non-fatal — the cart is created, just status didn't update
            System.debug(LoggingLevel.WARN,
                'Could not update plan status after conversion: ' + ex.getMessage());
        }

        // ── Write a sync log entry ────────────────────────────────────────────
        RL_Anaplan_Sync_Log__c logEntry = new RL_Anaplan_Sync_Log__c(
            Assortment_Plan__c = planId,
            Sync_Timestamp__c  = Datetime.now(),
            Triggered_By__c    = 'Manual Trigger',
            Records_Updated__c = lines.size(),
            Status__c          = 'Success',
            Error_Detail__c    = 'Converted to B2B Commerce cart: ' + cart.Id
                                 + ' | PO: ' + poNumber
        );
        try { insert logEntry; } catch (Exception e) { /* non-fatal */ }

        return cart.Id;
    }

    /** Returns the first active WebStore Id in the org.
     *  In production, source this from a Custom Metadata record keyed to the
     *  RL brand / region rather than querying. */
    private static String getDefaultWebStoreId() {
        List<WebStore> stores = [
            SELECT Id FROM WebStore WHERE Type = 'B2B' LIMIT 1
        ];
        if (stores.isEmpty()) {
            throw new AuraHandledException(
                'No B2B WebStore found in this org. '
                + 'Please configure a WebStore before converting assortments to orders.'
            );
        }
        return stores[0].Id;
    }

    // ── Private: UUID v4 token generator ─────────────────────────────────────
    private static String generateToken() {
        String hex = EncodingUtil.convertToHex(Crypto.generateAesKey(128));
        return hex.substring(0,  8) + '-' +
               hex.substring(8,  12) + '-' +
               '4' + hex.substring(13, 16) + '-' +
               hex.substring(16, 20) + '-' +
               hex.substring(20, 32);
    }
}
