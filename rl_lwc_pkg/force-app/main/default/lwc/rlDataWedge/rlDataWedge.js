import { LightningElement, api, wire, track } from 'lwc';
import { ShowToastEvent }   from 'lightning/platformShowToastEvent';
import { NavigationMixin }  from 'lightning/navigation';

// ── Re-use the same Apex controller as rlPictureWedge ─────────────────────────
import getAssortmentLines   from '@salesforce/apex/RLAssortmentController.getAssortmentLines';
import updateLineSequences  from '@salesforce/apex/RLAssortmentController.updateLineSequences';
import updateLineField      from '@salesforce/apex/RLAssortmentController.updateLineField';
import lockAssortmentPlan   from '@salesforce/apex/RLAssortmentController.lockAssortmentPlan';
import generateShareToken   from '@salesforce/apex/RLAssortmentController.generateShareToken';
import getSizeRuns          from '@salesforce/apex/RLAssortmentController.getSizeRunsForPlan';
import convertToOrder       from '@salesforce/apex/RLAssortmentController.convertToOrder';
// import createEmbeddedSigningEnvelope from '@salesforce/apex/DocuSignService.createEmbeddedSigningEnvelope';

// ── Constants ─────────────────────────────────────────────────────────────────
const SORT_SEQ      = 'seq';
const SORT_UNITS    = 'units';
const SORT_VARIANCE = 'variance';
const SORT_COST     = 'cost';
const SORT_DOORS    = 'doors';

const GROUP_NONE    = 'NONE';
const GROUP_FOB     = 'FOB';
const GROUP_TIER    = 'TIER';
const GROUP_DELIVERY= 'DELIVERY';

const FILTER_ALL    = 'ALL';
const FILTER_HERO   = 'HERO';
const FILTER_BELOW  = 'BELOW';  // below target by >5%
const FILTER_TIER_A = 'TIER_A';
const FILTER_TIER_B = 'TIER_B';
const FILTER_TIER_C = 'TIER_C';

export default class RlDataWedge extends NavigationMixin(LightningElement) {

    // ── Public properties ─────────────────────────────────────────────────────
    /** RL_Assortment_Plan__c Id — set automatically on record pages, pass via URL on Experience Cloud */
    @api recordId;

    /** Read-only buyer mode — set to true on Experience Cloud buyer portal */
    @api buyerMode = false;

    /** Maximum doors in this account's network — used to scale the door bar */
    @api maxDoors = 12;

    // ── Tracked state ─────────────────────────────────────────────────────────
    @track _effectiveRecordId;      // computed recordId for wire decorator
    @track allLines       = [];     // raw sorted master list
    @track displayLines   = [];     // after filter + sort + group applied
    @track groupedRows    = [];     // [{isGroup, isTotal, ...line}] for template
    @track sizeRunMap     = {};     // lineId → [{sizeCode, plannedUnits, isCoreSize, sortOrder}]

    @track isLoading       = true;
    @track isSizesLoading  = false;
    @track isSaving        = false;
    @track error           = null;

    // Plan header
    @track planName       = '';
    @track planStatus     = '';
    @track accountName    = '';
    @track season         = '';
    @track fob            = '';
    @track lastSync       = '';
    @track shareUrl       = '';
    @track shareToken     = '';

    // UI state
    @track activeFilter   = FILTER_ALL;
    @track activeSort     = SORT_SEQ;
    @track sortAsc        = true;
    @track activeGroup    = GROUP_FOB;
    @track expandedSizes  = {};     // lineId → boolean (size run expanded)
    @track showShareModal = false;
    @track showNoteModal  = false;
    @track editingLine    = null;
    @track noteValue      = '';
    @track searchTerm     = '';
    @track selectedLines  = new Set();
    @track showBulkBar    = false;

    // ── Analyze Gaps state ────────────────────────────────────────────────────
    @track showGapsModal  = false;
    @track isAnalyzing    = false;
    @track gapAnalysis    = null;
    @track gapError       = null;

    // ── Convert to Order state ────────────────────────────────────────────────
    @track showConvertModal   = false;
    @track isConverting       = false;
    @track convertSuccess     = false;
    @track convertError       = null;
    @track createdOrderId     = '';
    @track orderPONumber      = '';
    @track orderDeliveryDate  = '';
    @track orderNotes         = '';
    @track flaggedOption      = 'include';  // 'include' | 'exclude'

    // ── DocuSign Signing state ────────────────────────────────────────────────
    @track showSigningModal   = false;
    @track signingUrl         = '';
    @track envelopeId         = '';
    @track isSigning          = false;
    @track pendingOrderId     = '';  // Order ID waiting for signature

    connectedCallback() {
        // Ensure we have a recordId - use @api property or extract from URL
        if (!this.recordId) {
            const match = window.location.href.match(/\/([a-zA-Z0-9]{15,18})(?:\/|$)/);
            if (match && match[1]) {
                this.recordId = match[1];
            }
        }
        // Set the tracked property for wire binding
        this._effectiveRecordId = this.recordId;
    }

    // ── Wire: load lines ───────────────────────────────────────────────────────
    @wire(getAssortmentLines, { planId: '$_effectiveRecordId' })
    wiredLines({ data, error }) {
        this.isLoading = false;
        if (data) {
            this.error = null;
            this._processLines(data);
        } else if (error) {
            this.error = error?.body?.message || 'Failed to load assortment data.';
        }
    }

    // ── Wire: load size runs for the plan ─────────────────────────────────────
    @wire(getSizeRuns, { planId: '$_effectiveRecordId' })
    wiredSizes({ data, error }) {
        this.isSizesLoading = false;
        if (data) {
            // Build map: lineId → sorted size records
            const map = {};
            data.forEach(s => {
                if (!map[s.lineId]) map[s.lineId] = [];
                map[s.lineId].push({
                    sizeCode:     s.sizeCode,
                    plannedUnits: s.plannedUnits,
                    targetUnits:  s.targetUnits,
                    isCoreSize:   s.isCoreSize,
                    sortOrder:    s.sizeSortOrder || 99,
                });
            });
            // Sort each size array
            Object.keys(map).forEach(k => {
                map[k].sort((a, b) => a.sortOrder - b.sortOrder);
            });
            this.sizeRunMap = map;
            console.log('✓ Sizes loaded: ' + Object.keys(map).length + ' line groups');
        } else if (error) {
            console.warn('⚠️ Size runs failed to load (this is optional):', error);
            this.sizeRunMap = {};
        }
    }

    // ── Data processing ───────────────────────────────────────────────────────
    _processLines(data) {
        if (data.length > 0) {
            const h          = data[0];
            this.planName    = h.planName    || '';
            this.planStatus  = h.planStatus  || '';
            this.accountName = h.accountName || '';
            this.season      = h.season      || '';
            this.fob         = h.fob         || '';
            this.lastSync    = h.lastSync    ? this._fmtDate(h.lastSync) : '';
        }

        this.allLines = data.map((d, idx) => {
            const planned = d.plannedUnits  || 0;
            const target  = d.targetUnits   || 0;
            const cost    = d.wholesaleUnitCost || 0;
            const ext     = d.extendedCost  || 0;
            const varU    = planned - target;
            const varP    = target ? ((planned - target) / target) * 100 : 0;
            const doors   = d.doorCount     || 0;
            return {
                id:              d.id,
                seq:             d.displaySequence || (idx + 1),
                styleNumber:     d.styleNumber  || '',
                productName:     d.productName  || '',
                colorway:        d.colorway     || '',
                imageUrl:        d.imageUrl     || '',
                fob:             d.fob          || '',
                category:        d.category     || '',
                tier:            d.tier         || 'C',
                deliveryWindow:  d.deliveryWindow || '',
                plannedUnits:    planned,
                targetUnits:     target,
                varianceUnits:   varU,
                variancePct:     varP,
                varianceFmt:     this._fmtVariance(varP),
                varianceClass:   this._varianceClass(varP) + ' var-chip',
                unitCost:        cost,
                unitCostFmt:     this._fmtCurrency(cost),
                extCost:         ext,
                extCostFmt:      this._fmtCurrency(ext),
                doors:           doors,
                doorBarPct:      Math.min(100, Math.round((doors / this.maxDoors) * 100)),
                doorLabel:       doors + '/' + this.maxDoors,
                isHero:          d.isHeroOverride || d.isHeroStyle || false,
                isHeroStyle:     d.isHeroStyle    || false,
                isHeroOverride:  d.isHeroOverride || false,
                salesRepNote:    d.salesRepNote   || '',
                buyerNote:       d.buyerNote      || '',
                buyerStatus:     d.buyerStatus    || 'Pending Review',
                tierClass:       'tier-pill tier-' + (d.tier || 'c').toLowerCase(),
                buyerStatusClass:this._buyerStatusClass(d.buyerStatus),
                isSelected:      false,
                sizesExpanded:   false,
                sizeRowKey:      'size-' + d.id,
            };
        });

        this._rebuild();
    }

    // Full pipeline: filter → sort → group → build rows
    _rebuild() {
        let lines = [...this.allLines];

        // Search
        if (this.searchTerm) {
            const q = this.searchTerm.toLowerCase();
            lines = lines.filter(l =>
                l.styleNumber.toLowerCase().includes(q) ||
                l.productName.toLowerCase().includes(q) ||
                l.colorway.toLowerCase().includes(q)
            );
        }

        // Filter
        switch (this.activeFilter) {
            case FILTER_HERO:   lines = lines.filter(l => l.isHero);          break;
            case FILTER_BELOW:  lines = lines.filter(l => l.variancePct < -5); break;
            case FILTER_TIER_A: lines = lines.filter(l => l.tier === 'A');    break;
            case FILTER_TIER_B: lines = lines.filter(l => l.tier === 'B');    break;
            case FILTER_TIER_C: lines = lines.filter(l => l.tier === 'C');    break;
            default: break;
        }

        // Sort
        const dir = this.sortAsc ? 1 : -1;
        switch (this.activeSort) {
            case SORT_UNITS:    lines.sort((a,b) => dir * (a.plannedUnits - b.plannedUnits));   break;
            case SORT_VARIANCE: lines.sort((a,b) => dir * (a.variancePct  - b.variancePct));    break;
            case SORT_COST:     lines.sort((a,b) => dir * (a.extCost      - b.extCost));        break;
            case SORT_DOORS:    lines.sort((a,b) => dir * (a.doors        - b.doors));          break;
            default:            lines.sort((a,b) => dir * (a.seq          - b.seq));            break;
        }

        this.displayLines = lines;
        this._buildGroupedRows(lines);
    }

    _buildGroupedRows(lines) {
        if (this.activeGroup === GROUP_NONE) {
            this.groupedRows = lines.map(l => ({ ...l, isGroup: false, isTotal: false }));
            this._appendGrandTotal(lines);
            return;
        }

        const groupKey = l => {
            if (this.activeGroup === GROUP_FOB)      return l.fob      || 'Other';
            if (this.activeGroup === GROUP_TIER)     return 'Tier ' + (l.tier || 'C');
            if (this.activeGroup === GROUP_DELIVERY) return l.deliveryWindow || 'Unassigned';
            return '';
        };

        // Collect groups preserving current sort order
        const seen   = [];
        const groups = {};
        lines.forEach(l => {
            const k = groupKey(l);
            if (!groups[k]) { groups[k] = []; seen.push(k); }
            groups[k].push(l);
        });

        const rows = [];
        seen.forEach(k => {
            const g = groups[k];
            const gUnits = g.reduce((s, l) => s + l.plannedUnits, 0);
            const gExt   = g.reduce((s, l) => s + l.extCost,      0);
            const gTgt   = g.reduce((s, l) => s + l.targetUnits,   0);
            const gVarP  = gTgt ? ((gUnits - gTgt) / gTgt) * 100 : 0;
            rows.push({
                isGroup:       true,
                isTotal:       false,
                groupLabel:    k,
                groupStyles:   g.length + ' ' + (g.length === 1 ? 'style' : 'styles'),
                groupUnits:    gUnits.toLocaleString(),
                groupExt:      this._fmtCurrency(gExt),
                groupVarFmt:   this._fmtVariance(gVarP),
                groupVarClass: this._varianceClass(gVarP) + ' group-stat',
                id:            'grp-' + k,
            });
            g.forEach(l => rows.push({ ...l, isGroup: false, isTotal: false }));
        });

        // Grand total row
        const totUnits = lines.reduce((s,l) => s + l.plannedUnits, 0);
        const totExt   = lines.reduce((s,l) => s + l.extCost,      0);
        const totTgt   = lines.reduce((s,l) => s + l.targetUnits,  0);
        const totVarP  = totTgt ? ((totUnits - totTgt) / totTgt) * 100 : 0;
        rows.push({
            isGroup:       false,
            isTotal:       true,
            groupLabel:    'Total — ' + lines.length + ' styles',
            groupUnits:    totUnits.toLocaleString(),
            groupExt:      this._fmtCurrency(totExt),
            groupVarFmt:   this._fmtVariance(totVarP),
            groupVarClass: this._varianceClass(totVarP),
            id:            'grand-total',
        });

        this.groupedRows = rows;
    }

    _appendGrandTotal(lines) {
        const totUnits = lines.reduce((s,l) => s + l.plannedUnits, 0);
        const totExt   = lines.reduce((s,l) => s + l.extCost,      0);
        const totTgt   = lines.reduce((s,l) => s + l.targetUnits,  0);
        const totVarP  = totTgt ? ((totUnits - totTgt) / totTgt) * 100 : 0;
        this.groupedRows = [
            ...this.groupedRows,
            {
                isGroup:       false,
                isTotal:       true,
                groupLabel:    'Total — ' + lines.length + ' styles',
                groupUnits:    totUnits.toLocaleString(),
                groupExt:      this._fmtCurrency(totExt),
                groupVarFmt:   this._fmtVariance(totVarP),
                groupVarClass: this._varianceClass(totVarP),
                id:            'grand-total',
            }
        ];
    }

    // ── Computed getters ──────────────────────────────────────────────────────
    get totalStyles()  { return this.allLines.length; }
    get totalUnits()   { return this.allLines.reduce((s,l) => s + l.plannedUnits, 0).toLocaleString(); }
    get totalCost()    { return this._fmtCurrency(this.allLines.reduce((s,l) => s + l.extCost, 0)); }
    get totalVsTarget(){
        const u = this.allLines.reduce((s,l) => s + l.plannedUnits, 0);
        const t = this.allLines.reduce((s,l) => s + l.targetUnits,  0);
        return t ? this._fmtVariance(((u-t)/t)*100) : '—';
    }
    get totalVsTargetClass() {
        const u = this.allLines.reduce((s,l) => s + l.plannedUnits, 0);
        const t = this.allLines.reduce((s,l) => s + l.targetUnits,  0);
        return t ? this._varianceClass(((u-t)/t)*100) : 'var-neutral';
    }
    get totalVsTargetKpiClass() {
        return this.totalVsTargetClass + ' kpi-val';
    }
    get totalVsTargetGapCtxClass() {
        return this.totalVsTargetClass + ' gap-ctx';
    }
    get totalVsTargetVarChipClass() {
        return this.totalVsTargetClass + ' var-chip';
    }
    _getHeroTitle(isHero) {
        return isHero ? 'Remove hero flag' : 'Mark as hero';
    }
    _combineClasses(varClass, staticClass) {
        return varClass ? varClass + ' ' + staticClass : staticClass;
    }
    get belowTargetCount() { return this.allLines.filter(l => l.variancePct < -5).length; }
    get heroCount()         { return this.allLines.filter(l => l.isHero).length; }

    get isLocked()    { return this.planStatus === 'Locked' || this.planStatus === 'Converted to Order'; }
    get isReadOnly()  { return this.buyerMode || this.isLocked; }
    get showEmpty()   { return !this.isLoading && this.displayLines.length === 0; }
    get selectedCount() { return this.selectedLines.size; }
    get isConvertDisabled() { return this.selectedCount === 0; }

    // Convert modal computed getters
    get _orderableLines() {
        // Lines the buyer hasn't dropped
        let lines = this.allLines.filter(l => l.buyerStatus !== 'Dropped');
        // Optionally exclude flagged
        if (this.flaggedOption === 'exclude') {
            lines = lines.filter(l => l.buyerStatus !== 'Flagged for Discussion');
        }
        return lines;
    }
    get convertStyleCount() { return this._orderableLines.length; }
    get convertUnitCount()  {
        return this._orderableLines.reduce((s,l) => s + l.plannedUnits, 0).toLocaleString();
    }
    get convertTotalCost()  {
        return this._fmtCurrency(this._orderableLines.reduce((s,l) => s + l.extCost, 0));
    }
    get hasDroppedStyles()  { return this.allLines.some(l => l.buyerStatus === 'Dropped'); }
    get hasFlaggedStyles()  { return this.allLines.some(l => l.buyerStatus === 'Flagged for Discussion'); }
    get droppedStyleCount() { return this.allLines.filter(l => l.buyerStatus === 'Dropped').length; }
    get flaggedStyleCount() { return this.allLines.filter(l => l.buyerStatus === 'Flagged for Discussion').length; }
    get includeFlagged()    { return this.flaggedOption === 'include'; }
    get excludeFlagged()    { return this.flaggedOption === 'exclude'; }

    get buyerStatusOptions() {
        return [
            { label: 'Pending Review',         value: 'Pending Review' },
            { label: 'Approved',               value: 'Approved' },
            { label: 'Flagged for Discussion', value: 'Flagged for Discussion' },
            { label: 'Dropped',                value: 'Dropped' },
        ];
    }

    get statusBadgeClass() {
        const m = {
            'Draft':               'sbadge draft',
            'In Review':           'sbadge review',
            'Shared with Buyer':   'sbadge shared',
            'Locked':              'sbadge locked',
            'Converted to Order':  'sbadge converted',
        };
        return m[this.planStatus] || 'sbadge draft';
    }

    // Filter pill active states
    get fa()  { return this.activeFilter === FILTER_ALL; }
    get fh()  { return this.activeFilter === FILTER_HERO; }
    get fb()  { return this.activeFilter === FILTER_BELOW; }
    get fta() { return this.activeFilter === FILTER_TIER_A; }
    get ftb() { return this.activeFilter === FILTER_TIER_B; }
    get ftc() { return this.activeFilter === FILTER_TIER_C; }

    // Group tab active states
    get gFob()      { return this.activeGroup === GROUP_FOB; }
    get gTier()     { return this.activeGroup === GROUP_TIER; }
    get gDelivery() { return this.activeGroup === GROUP_DELIVERY; }
    get gNone()     { return this.activeGroup === GROUP_NONE; }

    // Sort arrow helpers
    _sortIcon(col) {
        if (this.activeSort !== col) return 'utility:arrowup';
        return this.sortAsc ? 'utility:arrowup' : 'utility:arrowdown';
    }
    _sortClass(col) {
        return this.activeSort === col ? 'th-sort active' : 'th-sort';
    }
    get sortSeqClass()      { return this._sortClass(SORT_SEQ); }
    get sortUnitsClass()    { return this._sortClass(SORT_UNITS); }
    get sortVarianceClass() { return this._sortClass(SORT_VARIANCE); }
    get sortCostClass()     { return this._sortClass(SORT_COST); }
    get sortDoorsClass()    { return this._sortClass(SORT_DOORS); }
    get sortSeqIcon()       { return this._sortIcon(SORT_SEQ); }
    get sortUnitsIcon()     { return this._sortIcon(SORT_UNITS); }
    get sortVarianceIcon()  { return this._sortIcon(SORT_VARIANCE); }
    get sortCostIcon()      { return this._sortIcon(SORT_COST); }
    get sortDoorsIcon()     { return this._sortIcon(SORT_DOORS); }

    // ── Sort handlers ─────────────────────────────────────────────────────────
    _handleSort(col) {
        if (this.activeSort === col) {
            this.sortAsc = !this.sortAsc;
        } else {
            this.activeSort = col;
            this.sortAsc    = col === SORT_SEQ;  // default asc for seq, desc for metrics
        }
        this._rebuild();
    }
    handleSortSeq()      { this._handleSort(SORT_SEQ); }
    handleSortUnits()    { this._handleSort(SORT_UNITS); }
    handleSortVariance() { this._handleSort(SORT_VARIANCE); }
    handleSortCost()     { this._handleSort(SORT_COST); }
    handleSortDoors()    { this._handleSort(SORT_DOORS); }

    // ── Filter handlers ───────────────────────────────────────────────────────
    _setFilter(f) { this.activeFilter = f; this._rebuild(); }
    handleFilterAll()   { this._setFilter(FILTER_ALL); }
    handleFilterHero()  { this._setFilter(FILTER_HERO); }
    handleFilterBelow() { this._setFilter(FILTER_BELOW); }
    handleFilterTierA() { this._setFilter(FILTER_TIER_A); }
    handleFilterTierB() { this._setFilter(FILTER_TIER_B); }
    handleFilterTierC() { this._setFilter(FILTER_TIER_C); }

    // ── Group handlers ────────────────────────────────────────────────────────
    _setGroup(g) { this.activeGroup = g; this._rebuild(); }
    handleGroupFob()      { this._setGroup(GROUP_FOB); }
    handleGroupTier()     { this._setGroup(GROUP_TIER); }
    handleGroupDelivery() { this._setGroup(GROUP_DELIVERY); }
    handleGroupNone()     { this._setGroup(GROUP_NONE); }

    // ── Search ────────────────────────────────────────────────────────────────
    handleSearch(evt) {
        this.searchTerm = evt.target.value || '';
        this._rebuild();
    }

    // ── Row checkbox selection ─────────────────────────────────────────────────
    handleSelectRow(evt) {
        const id = evt.currentTarget.dataset.id;
        const checked = evt.target.checked;
        if (checked) {
            this.selectedLines.add(id);
        } else {
            this.selectedLines.delete(id);
        }
        this.showBulkBar = this.selectedLines.size > 0;
        // Update isSelected on the line
        this.allLines = this.allLines.map(l =>
            l.id === id ? { ...l, isSelected: checked } : l
        );
        this._rebuild();
    }

    handleSelectAll(evt) {
        const checked = evt.target.checked;
        this.displayLines.forEach(l => {
            if (checked) { this.selectedLines.add(l.id); }
            else         { this.selectedLines.delete(l.id); }
        });
        this.showBulkBar = this.selectedLines.size > 0;
        this.allLines = this.allLines.map(l => ({
            ...l, isSelected: this.displayLines.some(d => d.id === l.id) ? checked : l.isSelected
        }));
        this._rebuild();
    }

    handleClearSelection() {
        this.selectedLines.clear();
        this.showBulkBar = false;
        this.allLines = this.allLines.map(l => ({ ...l, isSelected: false }));
        this._rebuild();
    }

    async handleConvertToOrder() {
        const selectedIds = Array.from(this.selectedLines);
        if (selectedIds.length === 0) {
            this._toast('No Selection', 'Please select items to convert to order.', 'error');
            return;
        }

        this.isSaving = true;
        try {
            // Create the order
            const orderId = await convertToOrder({
                planId: this._effectiveRecordId,
                selectedLineIds: selectedIds
            });

            // TODO: Enable DocuSign signing when configured
            // Uncomment below after setting up DocuSign API credentials

            /*
            // Store order ID and show signing modal
            this.pendingOrderId = orderId;
            this.isSigning = true;

            // Initiate DocuSign signing
            const signingResponse = await createEmbeddedSigningEnvelope({
                orderId: orderId,
                signerEmail: UserInfo.getUserEmail(),
                signerName: UserInfo.getName()
            });

            this.signingUrl = signingResponse.signingUrl;
            this.envelopeId = signingResponse.envelopeId;
            this.showSigningModal = true;

            this._toast('Sign Document', 'Please sign the order confirmation document.', 'info');
            */

            // For now, just create the order without signing
            this._toast('Success', `Order ${orderId} created with ${selectedIds.length} items.`, 'success');
            this.handleClearSelection();
            this.isSaving = false;

            // Navigate to the order
            this[NavigationMixin.Navigate]({
                type: 'standard__recordPage',
                attributes: {
                    recordId: orderId,
                    objectApiName: 'Order',
                    actionName: 'view'
                }
            });
        } catch (e) {
            this._toast('Error', e?.body?.message || 'Failed to create order.', 'error');
            this.isSaving = false;
        }
    }

    handleSigningComplete() {
        this.showSigningModal = false;
        this._toast('Success', `Order ${this.pendingOrderId} created and signed.`, 'success');
        this.handleClearSelection();
        this.isSaving = false;

        // Navigate to the order
        this[NavigationMixin.Navigate]({
            type: 'standard__recordPage',
            attributes: {
                recordId: this.pendingOrderId,
                objectApiName: 'Order',
                actionName: 'view'
            }
        });
    }

    handleSigningCancel() {
        this.showSigningModal = false;
        this.isSigning = false;
        this.isSaving = false;
        this._toast('Cancelled', 'Order signing was cancelled.', 'warning');
    }

    // ── Size run expand/collapse ───────────────────────────────────────────────
    handleToggleSizes(evt) {
        const id = evt.currentTarget.dataset.id;
        const current = this.expandedSizes[id] || false;
        this.expandedSizes = { ...this.expandedSizes, [id]: !current };
    }

    getSizesForLine(lineId) {
        return this.sizeRunMap[lineId] || [];
    }

    isSizeExpanded(lineId) {
        return !!this.expandedSizes[lineId];
    }

    // ── Hero toggle ───────────────────────────────────────────────────────────
    handleToggleHero(evt) {
        if (this.isReadOnly) return;
        const id     = evt.currentTarget.dataset.id;
        const line   = this.allLines.find(l => l.id === id);
        if (!line) return;
        const newVal = !line.isHero;
        this.allLines = this.allLines.map(l =>
            l.id === id ? { ...l, isHero: newVal, isHeroOverride: newVal } : l
        );
        this._rebuild();
        updateLineField({ lineId: id, fieldName: 'Is_Hero_Override__c', boolValue: newVal })
            .catch(e => this._toast('Error', e?.body?.message, 'error'));
    }

    // ── Note modal ────────────────────────────────────────────────────────────
    handleOpenNote(evt) {
        const id = evt.currentTarget.dataset.id;
        this.editingLine = this.allLines.find(l => l.id === id);
        this.noteValue   = this.buyerMode
            ? (this.editingLine?.buyerNote   || '')
            : (this.editingLine?.salesRepNote || '');
        this.showNoteModal = true;
    }

    handleNoteChange(evt)  { this.noteValue = evt.target.value; }

    handleSaveNote() {
        if (!this.editingLine) return;
        const id        = this.editingLine.id;
        const fieldName = this.buyerMode ? 'Buyer_Note__c' : 'Sales_Rep_Note__c';
        this.allLines = this.allLines.map(l => {
            if (l.id !== id) return l;
            return this.buyerMode
                ? { ...l, buyerNote:    this.noteValue }
                : { ...l, salesRepNote: this.noteValue };
        });
        this.showNoteModal = false;
        this._rebuild();
        updateLineField({ lineId: id, fieldName, stringValue: this.noteValue })
            .catch(e => this._toast('Error saving note', e?.body?.message, 'error'));
    }

    handleCloseNote() { this.showNoteModal = false; this.editingLine = null; }

    // ── Buyer status (buyer mode) ─────────────────────────────────────────────
    handleBuyerStatusChange(evt) {
        if (!this.buyerMode) return;
        const { id } = evt.currentTarget.dataset;
        const status  = evt.detail.value;
        this.allLines = this.allLines.map(l =>
            l.id === id
                ? { ...l, buyerStatus: status, buyerStatusClass: this._buyerStatusClass(status) }
                : l
        );
        this._rebuild();
        updateLineField({ lineId: id, fieldName: 'Buyer_Status__c', stringValue: status })
            .catch(e => this._toast('Error', e?.body?.message, 'error'));
    }

    // ── Lock & share ──────────────────────────────────────────────────────────
    async handleLock() {
        if (this.isReadOnly) return;
        this.isSaving = true;
        try {
            await lockAssortmentPlan({ planId: this.recordId });
            this.planStatus = 'Locked';
            this._toast('Plan locked', 'The assortment has been locked and is ready to share.', 'success');
        } catch (e) {
            this._toast('Error', e?.body?.message, 'error');
        } finally { this.isSaving = false; }
    }

    async handleShare() {
        this.isSaving = true;
        try {
            const token     = await generateShareToken({ planId: this.recordId });
            this.shareToken = token;
            const base      = window.location.origin;
            this.shareUrl   = `${base}/s/assortment?planId=${this.recordId}&token=${token}`;
            this.showShareModal = true;
            if (this.planStatus === 'Draft' || this.planStatus === 'In Review') {
                this.planStatus = 'Shared with Buyer';
            }
        } catch (e) {
            this._toast('Error', e?.body?.message, 'error');
        } finally { this.isSaving = false; }
    }

    handleCopyLink() {
        navigator.clipboard.writeText(this.shareUrl)
            .then(()  => this._toast('Copied', 'Link copied to clipboard.', 'success'))
            .catch(()  => this._toast('Error',  'Could not copy to clipboard.', 'error'));
    }

    handleCloseShare() { this.showShareModal = false; }

    // ── Navigate to plan record ───────────────────────────────────────────────
    handleOpenRecord() {
        this[NavigationMixin.Navigate]({
            type: 'standard__recordPage',
            attributes: { recordId: this.recordId, actionName: 'view' },
        });
    }

    // ── Export to CSV ─────────────────────────────────────────────────────────
    handleExportCsv() {
        const headers = [
            'Seq','Style Number','Product Name','Colorway','FOB','Tier',
            'Planned Units','Target Units','Variance %','Unit Cost','Ext Cost',
            'Doors','Delivery Window','Hero','Buyer Status','Rep Note'
        ];
        const rows = this.displayLines.map(l => [
            l.seq, l.styleNumber, `"${l.productName}"`, `"${l.colorway}"`,
            l.fob, l.tier, l.plannedUnits, l.targetUnits,
            l.varianceFmt, l.unitCostFmt, l.extCostFmt,
            l.doors, l.deliveryWindow,
            l.isHero ? 'Yes' : 'No',
            `"${l.buyerStatus}"`, `"${l.salesRepNote.replace(/"/g, '""')}"`
        ]);
        const csv  = [headers, ...rows].map(r => r.join(',')).join('\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `${this.planName.replace(/\s+/g, '_')}_DataWedge.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }

    // ── Refresh ───────────────────────────────────────────────────────────────
    handleRefresh() {
        this.isLoading = true;
        const id = this.recordId;
        this.recordId = undefined;
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        setTimeout(() => { this.recordId = id; }, 50);
    }

    // ── Analyze Gaps ──────────────────────────────────────────────────────────

    async handleAnalyzeGaps() {
        this.showGapsModal = true;
        this.isAnalyzing   = true;
        this.gapAnalysis   = null;
        this.gapError      = null;

        try {
            // Build a concise assortment snapshot for the AI prompt
            const snapshot = this._buildAssortmentSnapshot();
            const analysis = await this._callClaudeForGapAnalysis(snapshot);
            this.gapAnalysis = analysis;
        } catch (e) {
            this.gapError = e?.message || 'Gap analysis failed. Please try again.';
        } finally {
            this.isAnalyzing = false;
        }
    }

    handleCloseGaps() {
        this.showGapsModal = false;
    }

    handleExportGaps() {
        if (!this.gapAnalysis) return;
        const lines = [
            `RL Assortment Gap Analysis — ${this.planName}`,
            `Generated: ${new Date().toLocaleDateString()}`,
            '',
            '=== SUMMARY ===',
            this.gapAnalysis.summary,
            '',
            '=== FINDINGS ===',
            ...this.gapAnalysis.findings.map(f =>
                `[${f.severityLabel}] ${f.category} — ${f.title}\n${f.detail}\nAction: ${f.recommendedAction}`
            ),
            '',
            '=== STYLE RECOMMENDATIONS ===',
            'Style,Product,Plan Units,Target,Variance,Recommendation,Priority',
            ...(this.gapAnalysis.styleRecs || []).map(r =>
                `${r.styleNumber},"${r.productName}",${r.plannedUnits},${r.targetUnits},${r.varianceFmt},"${r.recommendation}",${r.priority}`
            ),
        ];
        const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `${this.planName.replace(/\s+/g,'_')}_GapAnalysis.txt`;
        a.click();
        URL.revokeObjectURL(url);
    }

    _buildAssortmentSnapshot() {
        // Summarize the assortment for the AI — keep it concise to control token count
        const overall = {
            plan:       this.planName,
            account:    this.accountName,
            season:     this.season,
            totalStyles:this.allLines.length,
            totalPlanned:this.allLines.reduce((s,l) => s + l.plannedUnits, 0),
            totalTarget: this.allLines.reduce((s,l) => s + l.targetUnits,  0),
            totalCost:   this.allLines.reduce((s,l) => s + l.extCost,      0),
        };

        // Style-level data — include all fields relevant to gap analysis
        const styles = this.allLines.map(l => ({
            styleNumber:   l.styleNumber,
            productName:   l.productName,
            fob:           l.fob,
            tier:          l.tier,
            plannedUnits:  l.plannedUnits,
            targetUnits:   l.targetUnits,
            variancePct:   Math.round(l.variancePct * 10) / 10,
            extCost:       Math.round(l.extCost),
            doors:         l.doors,
            maxDoors:      this.maxDoors,
            deliveryWindow:l.deliveryWindow,
            isHero:        l.isHero,
            buyerStatus:   l.buyerStatus,
        }));

        // Tier mix summary
        const tierMix = { A: 0, B: 0, C: 0 };
        this.allLines.forEach(l => { if (tierMix[l.tier] !== undefined) tierMix[l.tier]++; });

        // FOB breakdown
        const fobBreakdown = {};
        this.allLines.forEach(l => {
            const f = l.fob || 'Other';
            if (!fobBreakdown[f]) fobBreakdown[f] = { styles: 0, units: 0, target: 0 };
            fobBreakdown[f].styles++;
            fobBreakdown[f].units  += l.plannedUnits;
            fobBreakdown[f].target += l.targetUnits;
        });

        return { overall, styles, tierMix, fobBreakdown };
    }

    async _callClaudeForGapAnalysis(snapshot) {
        const prompt = `You are a wholesale fashion planning analyst reviewing a Ralph Lauren B2B seasonal assortment plan.

ASSORTMENT OVERVIEW:
- Plan: ${snapshot.overall.plan} (${snapshot.overall.account}, ${snapshot.overall.season})
- Total styles: ${snapshot.overall.totalStyles}
- Planned units: ${snapshot.overall.totalPlanned} vs target: ${snapshot.overall.totalTarget} (${snapshot.overall.totalTarget ? ((snapshot.overall.totalPlanned - snapshot.overall.totalTarget) / snapshot.overall.totalTarget * 100).toFixed(1) : 0}% variance)
- Tier mix: A=${snapshot.tierMix.A} styles, B=${snapshot.tierMix.B} styles, C=${snapshot.tierMix.C} styles

FOB BREAKDOWN:
${Object.entries(snapshot.fobBreakdown).map(([fob, d]) =>
    `- ${fob}: ${d.styles} styles, ${d.units} units planned vs ${d.target} target`
).join('\n')}

STYLE-LEVEL DATA (${snapshot.styles.length} styles):
${snapshot.styles.map(s =>
    `${s.styleNumber} | ${s.productName} | ${s.fob} | Tier ${s.tier} | Planned: ${s.plannedUnits} | Target: ${s.targetUnits} | Var: ${s.variancePct}% | Doors: ${s.doors}/${s.maxDoors} | ${s.deliveryWindow} | Hero: ${s.isHero} | Buyer: ${s.buyerStatus}`
).join('\n')}

Analyse this assortment for gaps and provide recommendations. Focus on:
1. Styles significantly below target (>5% negative variance)
2. Tier A hero styles with insufficient unit depth or door coverage
3. FOBs where planned mix is materially off target
4. Door distribution gaps — styles not reaching enough doors
5. Delivery window concentration risks
6. Buyer-flagged or buyer-dropped styles that need attention

Respond ONLY with valid JSON in this exact structure (no markdown, no preamble):
{
  "summary": "2-3 sentence executive summary of the overall assortment health",
  "findings": [
    {
      "id": "f1",
      "category": "Unit Depth | Door Coverage | Tier Mix | FOB Balance | Delivery Risk | Buyer Signals",
      "severity": "high | medium | low",
      "severityLabel": "High Priority | Medium Priority | Low Priority",
      "title": "Short finding title",
      "detail": "1-2 sentence explanation with specific numbers",
      "recommendedAction": "Specific actionable recommendation"
    }
  ],
  "styleRecs": [
    {
      "styleNumber": "RL-XXXX",
      "productName": "Product name",
      "plannedUnits": 0,
      "targetUnits": 0,
      "varianceFmt": "+0.0%",
      "recommendation": "Specific recommendation for this style",
      "priority": "Urgent | Review | Monitor"
    }
  ]
}
Include only styles in styleRecs that need specific action (below -5% variance, flagged by buyer, or hero styles with issues). Maximum 10 styleRecs. Maximum 8 findings.`;

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model:      'claude-sonnet-4-6',
                max_tokens: 2000,
                messages:   [{ role: 'user', content: prompt }],
            }),
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err?.error?.message || `API error ${response.status}`);
        }

        const data = await response.json();
        const text = data?.content?.[0]?.text || '';

        let parsed;
        try {
            // Strip any accidental markdown code fences
            const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            parsed = JSON.parse(clean);
        } catch {
            throw new Error('Could not parse AI response. Please try again.');
        }

        // Enrich each finding with CSS class
        parsed.findings = (parsed.findings || []).map(f => ({
            ...f,
            cardClass: `finding-card finding-${f.severity || 'low'}`,
            severityClass: `sev-pill sev-${f.severity || 'low'}`,
        }));

        // Enrich style recs with variance CSS
        parsed.styleRecs = (parsed.styleRecs || []).map(r => {
            const match = this.allLines.find(l => l.styleNumber === r.styleNumber);
            const pct   = match ? match.variancePct : 0;
            return {
                ...r,
                varianceFmt:  r.varianceFmt || this._fmtVariance(pct),
                varianceClass:this._varianceClass(pct),
                priorityClass:`priority-pill priority-${(r.priority || 'Monitor').toLowerCase().replace(/\s+/g,'-')}`,
            };
        });

        return parsed;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    _fmtVariance(pct) {
        if (pct === null || pct === undefined) return '—';
        return (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%';
    }
    _varianceClass(pct) {
        if (pct >  2)  return 'var-positive';
        if (pct < -5)  return 'var-negative';
        return 'var-neutral';
    }
    _fmtCurrency(n) {
        if (!n && n !== 0) return '—';
        return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    }
    _fmtDate(iso) {
        try {
            return new Date(iso).toLocaleDateString('en-US', {
                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
            });
        } catch { return iso; }
    }
    _buyerStatusClass(status) {
        const m = {
            'Approved':               'bstat approved',
            'Flagged for Discussion': 'bstat flagged',
            'Dropped':                'bstat dropped',
            'Pending Review':         'bstat pending',
        };
        return m[status] || 'bstat pending';
    }
    _toast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message: message || '', variant }));
    }
}
