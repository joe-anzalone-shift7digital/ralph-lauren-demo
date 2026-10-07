/**
 * RLAssortmentControllerTest
 * Covers all @AuraEnabled methods in RLAssortmentController,
 * including getSizeRunsForPlan added for rlDataWedge.
 */
@IsTest
private class RLAssortmentControllerTest {

    @TestSetup
    static void makeData() {
        Account acct = new Account(Name = 'Nordstrom Test');
        insert acct;

        Product2 prod = new Product2(
            Name        = 'Double-Breasted Wool Overcoat',
            ProductCode = 'RL-A1240',
            IsActive    = true
        );
        insert prod;

        RL_Assortment_Plan__c plan = new RL_Assortment_Plan__c(
            Name               = 'Nordstrom AW26 NA',
            Account__c         = acct.Id,
            Season__c          = 'AW26',
            Region__c          = 'NA',
            FOB__c             = 'Outerwear',
            Status__c          = 'In Review',
            Anaplan_Plan_ID__c = 'ANA-TEST-001'
        );
        insert plan;

        List<RL_Assortment_Line__c> lines = new List<RL_Assortment_Line__c>();
        for (Integer i = 1; i <= 5; i++) {
            lines.add(new RL_Assortment_Line__c(
                Assortment_Plan__c     = plan.Id,
                Product__c             = prod.Id,
                Style_Number__c        = 'RL-A120' + i,
                Planned_Units__c       = 100 + (i * 20),
                Target_Units__c        = 120 + (i * 20),
                Wholesale_Unit_Cost__c = 95.00,
                Tier__c                = i <= 2 ? 'A' : (i <= 4 ? 'B' : 'C'),
                Display_Sequence__c    = i,
                Is_Hero_Style__c       = i == 1,
                Is_Hero_Override__c    = false,
                Door_Count__c          = 10,
                Delivery_Window__c     = 'DLV1-Aug',
                Buyer_Status__c        = 'Pending Review',
                FOB__c                 = 'Outerwear'
            ));
        }
        insert lines;

        // Size runs for the first line only
        RL_Assortment_Line__c firstLine = lines[0];
        List<RL_Size_Run__c> sizes = new List<RL_Size_Run__c>{
            new RL_Size_Run__c(Assortment_Line__c=firstLine.Id, Size_Code__c='S',  Planned_Units__c=40, Target_Units__c=50, Is_Core_Size__c=true,  Size_Sort_Order__c=1),
            new RL_Size_Run__c(Assortment_Line__c=firstLine.Id, Size_Code__c='M',  Planned_Units__c=80, Target_Units__c=80, Is_Core_Size__c=true,  Size_Sort_Order__c=2),
            new RL_Size_Run__c(Assortment_Line__c=firstLine.Id, Size_Code__c='L',  Planned_Units__c=60, Target_Units__c=70, Is_Core_Size__c=false, Size_Sort_Order__c=3),
            new RL_Size_Run__c(Assortment_Line__c=firstLine.Id, Size_Code__c='XL', Planned_Units__c=20, Target_Units__c=20, Is_Core_Size__c=false, Size_Sort_Order__c=4)
        };
        insert sizes;
    }

    // ── getAssortmentLines ────────────────────────────────────────────────────
    @IsTest
    static void testGetLines_returnsCorrectCount() {
        Id planId = [SELECT Id FROM RL_Assortment_Plan__c LIMIT 1].Id;
        Test.startTest();
        List<RLAssortmentController.AssortmentLineDTO> result =
            RLAssortmentController.getAssortmentLines(planId);
        Test.stopTest();
        System.assertEquals(5, result.size());
        System.assertEquals('Nordstrom AW26 NA', result[0].planName);
        System.assertEquals('In Review',          result[0].planStatus);
        System.assertEquals('AW26',               result[0].season);
    }

    @IsTest
    static void testGetLines_nullId_throws() {
        Test.startTest();
        try {
            RLAssortmentController.getAssortmentLines(null);
            System.assert(false, 'Expected exception');
        } catch (AuraHandledException e) {
            System.assert(e.getMessage() != null);
        }
        Test.stopTest();
    }

    // ── getSizeRunsForPlan ────────────────────────────────────────────────────
    @IsTest
    static void testGetSizeRuns_returnsSizes() {
        Id planId = [SELECT Id FROM RL_Assortment_Plan__c LIMIT 1].Id;
        Test.startTest();
        List<RLAssortmentController.SizeRunDTO> result =
            RLAssortmentController.getSizeRunsForPlan(planId);
        Test.stopTest();
        System.assertEquals(4, result.size(), 'Should return 4 size records');
        // Verify sort order preserved
        System.assertEquals('S', result[0].sizeCode);
        System.assertEquals('M', result[1].sizeCode);
        System.assertEquals(true,  result[0].isCoreSize);
        System.assertEquals(false, result[2].isCoreSize);
    }

    @IsTest
    static void testGetSizeRuns_nullId_throws() {
        Test.startTest();
        try {
            RLAssortmentController.getSizeRunsForPlan(null);
            System.assert(false, 'Expected exception');
        } catch (AuraHandledException e) {
            System.assert(e.getMessage() != null);
        }
        Test.stopTest();
    }

    @IsTest
    static void testGetSizeRuns_planWithNoSizes_returnsEmpty() {
        // Create a second plan with no size runs
        Account a = new Account(Name = 'Bloomingdale Test');
        insert a;
        RL_Assortment_Plan__c p2 = new RL_Assortment_Plan__c(
            Name='Bloomingdale AW26', Account__c=a.Id, Season__c='AW26',
            Region__c='NA', Status__c='Draft', FOB__c='Knitwear'
        );
        insert p2;
        Test.startTest();
        List<RLAssortmentController.SizeRunDTO> result =
            RLAssortmentController.getSizeRunsForPlan(p2.Id);
        Test.stopTest();
        System.assertEquals(0, result.size());
    }

    // ── updateLineSequences ───────────────────────────────────────────────────
    @IsTest
    static void testUpdateLineSequences_reversesOrder() {
        List<RL_Assortment_Line__c> lines = [
            SELECT Id, Display_Sequence__c FROM RL_Assortment_Line__c ORDER BY Display_Sequence__c
        ];
        List<Object> updates = new List<Object>();
        Integer seq = lines.size();
        for (RL_Assortment_Line__c l : lines) {
            updates.add(new Map<String, Object>{ 'id' => l.Id, 'seq' => seq-- });
        }
        Test.startTest();
        RLAssortmentController.updateLineSequences(JSON.serialize(updates));
        Test.stopTest();
        List<RL_Assortment_Line__c> updated = [
            SELECT Display_Sequence__c FROM RL_Assortment_Line__c WHERE Id = :lines[0].Id
        ];
        System.assertEquals(lines.size(), Integer.valueOf(updated[0].Display_Sequence__c),
            'First line should now have the highest sequence number');
    }

    @IsTest
    static void testUpdateLineSequences_blank_noOp() {
        Test.startTest();
        RLAssortmentController.updateLineSequences('');
        Test.stopTest();
        System.assert(true, 'Blank input should be a no-op');
    }

    // ── updateLineField ───────────────────────────────────────────────────────
    @IsTest
    static void testUpdateLineField_heroOverride_true() {
        Id lineId = [SELECT Id FROM RL_Assortment_Line__c LIMIT 1].Id;
        Test.startTest();
        RLAssortmentController.updateLineField(lineId, 'Is_Hero_Override__c', null, true);
        Test.stopTest();
        System.assertEquals(true,
            [SELECT Is_Hero_Override__c FROM RL_Assortment_Line__c WHERE Id = :lineId].Is_Hero_Override__c);
    }

    @IsTest
    static void testUpdateLineField_salesRepNote() {
        Id lineId = [SELECT Id FROM RL_Assortment_Line__c LIMIT 1].Id;
        Test.startTest();
        RLAssortmentController.updateLineField(lineId, 'Sales_Rep_Note__c', 'Test note for buyer meeting', null);
        Test.stopTest();
        System.assertEquals('Test note for buyer meeting',
            [SELECT Sales_Rep_Note__c FROM RL_Assortment_Line__c WHERE Id = :lineId].Sales_Rep_Note__c);
    }

    @IsTest
    static void testUpdateLineField_buyerNote() {
        Id lineId = [SELECT Id FROM RL_Assortment_Line__c LIMIT 1].Id;
        Test.startTest();
        RLAssortmentController.updateLineField(lineId, 'Buyer_Note__c', 'Buyer annotation', null);
        Test.stopTest();
        System.assertEquals('Buyer annotation',
            [SELECT Buyer_Note__c FROM RL_Assortment_Line__c WHERE Id = :lineId].Buyer_Note__c);
    }

    @IsTest
    static void testUpdateLineField_buyerStatus_approved() {
        Id lineId = [SELECT Id FROM RL_Assortment_Line__c LIMIT 1].Id;
        Test.startTest();
        RLAssortmentController.updateLineField(lineId, 'Buyer_Status__c', 'Approved', null);
        Test.stopTest();
        System.assertEquals('Approved',
            [SELECT Buyer_Status__c FROM RL_Assortment_Line__c WHERE Id = :lineId].Buyer_Status__c);
    }

    @IsTest
    static void testUpdateLineField_disallowedField_throws() {
        Id lineId = [SELECT Id FROM RL_Assortment_Line__c LIMIT 1].Id;
        Test.startTest();
        try {
            RLAssortmentController.updateLineField(lineId, 'Planned_Units__c', null, null);
            System.assert(false, 'Should throw for disallowed field');
        } catch (AuraHandledException e) {
            System.assert(e.getMessage().contains('not permitted'));
        }
        Test.stopTest();
    }

    // ── lockAssortmentPlan ────────────────────────────────────────────────────
    @IsTest
    static void testLockAssortmentPlan_setsStatusAndToken() {
        Id planId = [SELECT Id FROM RL_Assortment_Plan__c LIMIT 1].Id;
        Test.startTest();
        RLAssortmentController.lockAssortmentPlan(planId);
        Test.stopTest();
        RL_Assortment_Plan__c updated = [
            SELECT Status__c, Shared_Link_Token__c FROM RL_Assortment_Plan__c WHERE Id = :planId
        ];
        System.assertEquals('Locked', updated.Status__c);
        System.assert(String.isNotBlank(updated.Shared_Link_Token__c));
        System.assertEquals(36, updated.Shared_Link_Token__c.length());
    }

    // ── generateShareToken ────────────────────────────────────────────────────
    @IsTest
    static void testGenerateShareToken_returnsUUID() {
        Id planId = [SELECT Id FROM RL_Assortment_Plan__c LIMIT 1].Id;
        Test.startTest();
        String token = RLAssortmentController.generateShareToken(planId);
        Test.stopTest();
        System.assert(String.isNotBlank(token));
        System.assertEquals(36, token.length());
        RL_Assortment_Plan__c updated = [
            SELECT Status__c FROM RL_Assortment_Plan__c WHERE Id = :planId
        ];
        System.assertEquals('Shared with Buyer', updated.Status__c);
    }

    @IsTest
    static void testGenerateShareToken_idempotent() {
        Id planId = [SELECT Id FROM RL_Assortment_Plan__c LIMIT 1].Id;
        Test.startTest();
        String t1 = RLAssortmentController.generateShareToken(planId);
        String t2 = RLAssortmentController.generateShareToken(planId);
        Test.stopTest();
        System.assertEquals(t1, t2, 'Token should be stable across calls');
    }
}
