import { LightningElement, api, wire, track } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { NavigationMixin } from 'lightning/navigation';
import getAssortmentLines from '@salesforce/apex/RLAssortmentController.getAssortmentLines';
import updateLineSequences from '@salesforce/apex/RLAssortmentController.updateLineSequences';
import updateLineField from '@salesforce/apex/RLAssortmentController.updateLineField';
import lockAssortmentPlan from '@salesforce/apex/RLAssortmentController.lockAssortmentPlan';
import generateShareToken from '@salesforce/apex/RLAssortmentController.generateShareToken';

const FILTER_ALL       = 'ALL';
const FILTER_HERO      = 'HERO';
const FILTER_TIER_A    = 'TIER_A';
const FILTER_TIER_B    = 'TIER_B';
const FILTER_TIER_C    = 'TIER_C';
const VIEW_PICTURE     = 'PICTURE';
const VIEW_DATA        = 'DATA';

export default class RlPictureWedge extends NavigationMixin(LightningElement) {

    // ── Public properties ────────────────────────────────────────────────────
    /** Record ID of the RL_Assortment_Plan__c record */
    @api recordId;

    /** When true the component renders in read-only buyer mode (no drag/lock) */
    @api buyerMode = false;

    // ── Tracked state ────────────────────────────────────────────────────────
    @track _effectiveRecordId;            // computed recordId for wire decorator
    @track lines          = [];           // assortment line items (display order)
    @track filteredLines  = [];           // lines after filter applied
    @track isLoading      = true;
    @track error          = null;
    @track planStatus     = '';
    @track planName       = '';
    @track accountName    = '';
    @track season         = '';
    @track fob            = '';
    @track lastSync       = '';
    @track shareToken     = '';
    @track shareUrl       = '';

    @track activeFilter   = FILTER_ALL;
    @track activeView     = VIEW_PICTURE;
    @track isSaving       = false;
    @track showShareModal = false;
    @track showNoteModal  = false;
    @track editingLine    = null;
    @track noteValue      = '';

    // Drag state (not tracked — no re-render needed mid-drag)
    _dragSrcIndex = null;
    _dragSrcId    = null;

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

    // ── Wire: load lines from Apex ───────────────────────────────────────────
    @wire(getAssortmentLines, { planId: '$_effectiveRecordId' })
    wiredLines({ data, error }) {
        this.isLoading = false;
        if (data) {
            console.log('📦 Wired data received:', JSON.stringify(data));
            this.error = null;
            this._processData(data);
        } else if (error) {
            console.error('❌ Wire error:', error);
            this.error = error?.body?.message || 'Failed to load assortment data.';
        }
    }

    // ── Data processing ───────────────────────────────────────────────────────
    _processData(data) {
        // Header fields from the first record's parent plan
        if (data.length > 0) {
            const first = data[0];
            this.planName    = first.planName    || '';
            this.planStatus  = first.planStatus  || '';
            this.accountName = first.accountName || '';
            this.season      = first.season      || '';
            this.fob         = first.fob         || '';
            this.lastSync    = first.lastSync    ? this._formatDate(first.lastSync) : '';
        }

        // Map raw Apex data to display-friendly objects
        this.lines = data.map((d, idx) => ({
            id:              d.id,
            seq:             d.displaySequence || (idx + 1),
            styleNumber:     d.styleNumber     || '',
            productName:     d.productName     || '',
            category:        d.fob             || '',
            colorway:        d.colorway        || '',
            imageUrl:        d.imageUrl        || '',
            tier:            d.tier            || 'C',
            plannedUnits:    d.plannedUnits     || 0,
            targetUnits:     d.targetUnits      || 0,
            unitCost:        this._formatCurrency(d.wholesaleUnitCost || 0),
            extCost:         d.extendedCost     || 0,
            extCostFormatted:this._formatCurrency(d.extendedCost || 0),
            doorCount:       d.doorCount        || 0,
            deliveryWindow:  d.deliveryWindow   || '',
            isHero:          d.isHeroOverride   || d.isHeroStyle || false,
            salesRepNote:    d.salesRepNote     || '',
            buyerNote:       d.buyerNote        || '',
            buyerStatus:     d.buyerStatus      || 'Pending Review',
            variancePct:     this._variance(d.plannedUnits, d.targetUnits),
            varianceClass:   this._varianceClass(d.plannedUnits, d.targetUnits),
            tierClass:       'tier-badge tier-' + (d.tier || 'c').toLowerCase(),
            buyerStatusClass:this._buyerStatusClass(d.buyerStatus),
            dragging:        false,
            dragOver:        false,
        }));

        // Sort by sequence then apply filter
        this.lines.sort((a, b) => a.seq - b.seq);
        this._applyFilter();
    }

    _variance(planned, target) {
        if (!target) return '—';
        const pct = ((planned - target) / target) * 100;
        return (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%';
    }

    _varianceClass(planned, target) {
        if (!target) return 'var-neutral';
        const pct = ((planned - target) / target) * 100;
        if (pct > 2)  return 'var-positive';
        if (pct < -5) return 'var-negative';
        return 'var-neutral';
    }

    _buyerStatusClass(status) {
        const map = {
            'Approved':            'buyer-approved',
            'Flagged for Discussion': 'buyer-flagged',
            'Dropped':             'buyer-dropped',
            'Pending Review':      'buyer-pending',
        };
        return 'buyer-status ' + (map[status] || 'buyer-pending');
    }

    _formatDate(iso) {
        try {
            const d = new Date(iso);
            return d.toLocaleDateString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
        } catch { return iso; }
    }

    _formatCurrency(value) {
        if (!value) return '$0.00';
        return '$' + parseFloat(value).toFixed(2);
    }

    _applyFilter() {
        switch (this.activeFilter) {
            case FILTER_HERO:   this.filteredLines = this.lines.filter(l => l.isHero);         break;
            case FILTER_TIER_A: this.filteredLines = this.lines.filter(l => l.tier === 'A');   break;
            case FILTER_TIER_B: this.filteredLines = this.lines.filter(l => l.tier === 'B');   break;
            case FILTER_TIER_C: this.filteredLines = this.lines.filter(l => l.tier === 'C');   break;
            default:            this.filteredLines = [...this.lines];
        }
    }

    // ── Computed getters ──────────────────────────────────────────────────────
    get isPictureView()    { return this.activeView === VIEW_PICTURE; }
    get isDataView()       { return this.activeView === VIEW_DATA; }
    get isLocked()         { return this.planStatus === 'Locked' || this.planStatus === 'Converted to Order'; }
    get isReadOnly()       { return this.buyerMode || this.isLocked; }
    get canShare()         { return !this.buyerMode && !this.isLocked && this.planStatus !== 'Draft'; }
    get canLock()          { return !this.buyerMode && !this.isLocked; }
    get showEmptyState()   { return !this.isLoading && this.filteredLines.length === 0; }

    get totalUnits()       { return this.lines.reduce((s, l) => s + l.plannedUnits, 0).toLocaleString(); }
    get totalCost()        {
        const t = this.lines.reduce((s, l) => s + l.extCost, 0);
        return '$' + t.toLocaleString('en-US', { minimumFractionDigits:0, maximumFractionDigits:0 });
    }
    get styleCount()       { return this.lines.length; }

    get filterAll()       { return this.activeFilter === FILTER_ALL; }
    get filterHero()      { return this.activeFilter === FILTER_HERO; }
    get filterTierA()     { return this.activeFilter === FILTER_TIER_A; }
    get filterTierB()     { return this.activeFilter === FILTER_TIER_B; }
    get filterTierC()     { return this.activeFilter === FILTER_TIER_C; }

    get statusBadgeClass() {
        const map = {
            'Draft':               'status-draft',
            'In Review':           'status-review',
            'Shared with Buyer':   'status-shared',
            'Locked':              'status-locked',
            'Converted to Order':  'status-converted',
        };
        return 'status-badge ' + (map[this.planStatus] || 'status-draft');
    }

    get pictureViewClass() { return 'view-btn' + (this.isPictureView ? ' active' : ''); }
    get dataViewClass()    { return 'view-btn' + (this.isDataView    ? ' active' : ''); }

    // ── Filter handlers ───────────────────────────────────────────────────────
    handleFilterAll()    { this.activeFilter = FILTER_ALL;    this._applyFilter(); }
    handleFilterHero()   { this.activeFilter = FILTER_HERO;   this._applyFilter(); }
    handleFilterTierA()  { this.activeFilter = FILTER_TIER_A; this._applyFilter(); }
    handleFilterTierB()  { this.activeFilter = FILTER_TIER_B; this._applyFilter(); }
    handleFilterTierC()  { this.activeFilter = FILTER_TIER_C; this._applyFilter(); }

    handleImgError(evt) {
        const url = evt.target.src;
        console.error('❌ Image failed to load:', url);
    }

    // ── View toggle ───────────────────────────────────────────────────────────
    handleViewPicture()  { this.activeView = VIEW_PICTURE; }
    handleViewData()     { this.activeView = VIEW_DATA; }

    // ── Drag and drop (picture wedge resequencing) ────────────────────────────
    handleDragStart(evt) {
        if (this.isReadOnly) return;
        const idx = parseInt(evt.currentTarget.dataset.index, 10);
        this._dragSrcIndex = idx;
        this._dragSrcId    = this.filteredLines[idx].id;
        evt.dataTransfer.effectAllowed = 'move';
        evt.dataTransfer.setData('text/plain', idx);
        // Mark card as dragging (visual feedback)
        this.filteredLines = this.filteredLines.map((l, i) => ({
            ...l, dragging: i === idx
        }));
    }

    handleDragOver(evt) {
        evt.preventDefault();
        evt.dataTransfer.dropEffect = 'move';
        const idx = parseInt(evt.currentTarget.dataset.index, 10);
        this.filteredLines = this.filteredLines.map((l, i) => ({
            ...l, dragOver: i === idx && i !== this._dragSrcIndex
        }));
    }

    handleDragLeave(evt) {
        const idx = parseInt(evt.currentTarget.dataset.index, 10);
        this.filteredLines = this.filteredLines.map((l, i) => ({
            ...l, dragOver: i === idx ? false : l.dragOver
        }));
    }

    handleDrop(evt) {
        evt.preventDefault();
        const dropIdx = parseInt(evt.currentTarget.dataset.index, 10);
        if (dropIdx === this._dragSrcIndex) {
            this._clearDragState();
            return;
        }
        // Reorder filteredLines
        const reordered = [...this.filteredLines];
        const [moved] = reordered.splice(this._dragSrcIndex, 1);
        reordered.splice(dropIdx, 0, moved);

        // Assign new sequence numbers
        const updated = reordered.map((l, i) => ({ ...l, seq: i + 1, dragging: false, dragOver: false }));
        this.filteredLines = updated;

        // Also update the master lines array to keep in sync
        this.lines = this.lines.map(l => {
            const found = updated.find(u => u.id === l.id);
            return found ? { ...l, seq: found.seq } : l;
        });

        this._clearDragState();
        this._saveSequences(updated);
    }

    handleDragEnd() {
        this._clearDragState();
    }

    _clearDragState() {
        this._dragSrcIndex = null;
        this._dragSrcId    = null;
        this.filteredLines = this.filteredLines.map(l => ({ ...l, dragging: false, dragOver: false }));
    }

    async _saveSequences(orderedLines) {
        this.isSaving = true;
        try {
            const updates = orderedLines.map(l => ({ id: l.id, seq: l.seq }));
            await updateLineSequences({ sequenceUpdates: JSON.stringify(updates) });
            this._toast('Sequence saved', 'Style order updated successfully.', 'success');
        } catch (e) {
            this._toast('Save failed', e?.body?.message || 'Could not save sequence.', 'error');
        } finally {
            this.isSaving = false;
        }
    }

    // ── Card actions ──────────────────────────────────────────────────────────
    handleToggleHero(evt) {
        if (this.isReadOnly) return;
        const id = evt.currentTarget.dataset.id;
        const line = this.lines.find(l => l.id === id);
        if (!line) return;
        const newVal = !line.isHero;
        this.lines = this.lines.map(l => l.id === id ? { ...l, isHero: newVal } : l);
        this._applyFilter();
        updateLineField({ lineId: id, fieldName: 'Is_Hero_Override__c', boolValue: newVal })
            .catch(e => this._toast('Error', e?.body?.message, 'error'));
    }

    handleOpenNote(evt) {
        const id = evt.currentTarget.dataset.id;
        this.editingLine = this.lines.find(l => l.id === id);
        this.noteValue   = this.editingLine?.salesRepNote || '';
        this.showNoteModal = true;
    }

    handleNoteChange(evt) {
        this.noteValue = evt.target.value;
    }

    handleSaveNote() {
        if (!this.editingLine) return;
        const id = this.editingLine.id;
        this.lines = this.lines.map(l =>
            l.id === id ? { ...l, salesRepNote: this.noteValue } : l
        );
        this._applyFilter();
        this.showNoteModal = false;
        updateLineField({ lineId: id, fieldName: 'Sales_Rep_Note__c', stringValue: this.noteValue })
            .catch(e => this._toast('Error saving note', e?.body?.message, 'error'));
    }

    handleCloseNote() {
        this.showNoteModal = false;
        this.editingLine   = null;
    }

    // ── Buyer status update (buyer mode) ──────────────────────────────────────
    handleBuyerStatus(evt) {
        if (!this.buyerMode) return;
        const { id, status } = evt.currentTarget.dataset;
        this.lines = this.lines.map(l =>
            l.id === id
                ? { ...l, buyerStatus: status, buyerStatusClass: this._buyerStatusClass(status) }
                : l
        );
        this._applyFilter();
        updateLineField({ lineId: id, fieldName: 'Buyer_Status__c', stringValue: status })
            .catch(e => this._toast('Error', e?.body?.message, 'error'));
    }

    // ── Lock & share ──────────────────────────────────────────────────────────
    async handleLock() {
        if (this.isReadOnly) return;
        try {
            this.isSaving = true;
            await lockAssortmentPlan({ planId: this.recordId });
            this.planStatus = 'Locked';
            this._toast('Assortment locked', 'The plan has been locked. A share link has been generated.', 'success');
        } catch (e) {
            this._toast('Error', e?.body?.message, 'error');
        } finally {
            this.isSaving = false;
        }
    }

    async handleShare() {
        try {
            this.isSaving = true;
            const token = await generateShareToken({ planId: this.recordId });
            this.shareToken = token;
            const base = window.location.origin;
            this.shareUrl = `${base}/s/assortment?planId=${this.recordId}&token=${token}`;
            this.showShareModal = true;
        } catch (e) {
            this._toast('Error', e?.body?.message, 'error');
        } finally {
            this.isSaving = false;
        }
    }

    handleCopyLink() {
        navigator.clipboard.writeText(this.shareUrl)
            .then(() => this._toast('Copied', 'Share link copied to clipboard.', 'success'))
            .catch(() => this._toast('Error', 'Could not copy to clipboard.', 'error'));
    }

    handleCloseShare() {
        this.showShareModal = false;
    }

    // ── Refresh ───────────────────────────────────────────────────────────────
    handleRefresh() {
        this.isLoading = true;
        // Re-trigger wire by reassigning (LWC wire reactivity)
        const id = this.recordId;
        this.recordId = undefined;
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        setTimeout(() => { this.recordId = id; }, 50);
    }

    // ── Navigate to plan record ───────────────────────────────────────────────
    handleOpenRecord() {
        this[NavigationMixin.Navigate]({
            type: 'standard__recordPage',
            attributes: {
                recordId: this.recordId,
                actionName: 'view',
            },
        });
    }

    // ── Card drag CSS helper getters ──────────────────────────────────────────
    // These are accessed via template iteration — computed per card in JS
    getCardClass(line) {
        let cls = 'wedge-card';
        if (line.isHero)    cls += ' hero';
        if (line.dragging)  cls += ' dragging';
        if (line.dragOver)  cls += ' drag-over';
        return cls;
    }

    // ── Toast helper ─────────────────────────────────────────────────────────
    _toast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }
}
