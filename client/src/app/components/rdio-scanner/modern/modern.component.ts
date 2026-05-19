/*
 * *****************************************************************************
 * Copyright (C) 2019-2026 Chrystian Huot <chrystian.huot@saubeo.solutions>
 *
 * Mobile-first "Modern" view for the listener UI. Same backend wiring as
 * RdioScannerMainComponent (subscribes to service.event for call / config /
 * livefeed / pause / listeners), but a chat-app-style card feed instead of
 * a faux LCD scanner display. Hides the power-user controls (HOLD SYS,
 * HOLD TG, AVOID, SKIP NEXT, REPLAY LAST, SELECT TG) -- users who need
 * those flip back to the Classic view via the theme toggle.
 *
 * Licensed GPL-3.0-or-later, same as the rest of the project.
 * ****************************************************************************
 */

import { ChangeDetectorRef, Component, EventEmitter, OnDestroy, Output } from '@angular/core';
import {
    RdioScannerCall,
    RdioScannerConfig,
    RdioScannerEvent,
    RdioScannerLivefeedMode,
    RdioScannerPlaybackList,
    RdioScannerSearchOptions,
    RdioScannerSystem,
    RdioScannerTalkgroup,
} from '../rdio-scanner';
import { RdioScannerService } from '../rdio-scanner.service';

const RECENT_LIMIT = 100;
const BROWSE_PAGE = 50;

@Component({
    selector: 'rdio-scanner-modern',
    styleUrls: ['./modern.component.scss'],
    templateUrl: './modern.component.html',
})
export class RdioScannerModernComponent implements OnDestroy {
    /** User asked to switch back to the classic display. */
    @Output() switchToClassic = new EventEmitter<void>();

    config?: RdioScannerConfig;
    currentCall?: RdioScannerCall;
    /** Most-recent first. Capped at RECENT_LIMIT so memory stays bounded. */
    recent: RdioScannerCall[] = [];
    livefeedOn = false;
    paused = false;
    listeners = 0;
    branding = '';
    /** Server is asking for a PIN; modern view defers to classic for that flow. */
    needsAuth = false;

    // ---- browse-past-calls state ---------------------------------------
    /** Whether the slide-up browse sheet is visible. */
    browseOpen = false;
    /** yyyy-MM-dd, fed straight into <input type="date">. Empty = no date filter. */
    browseDate = '';
    /** Currently-selected system id (null = all systems). */
    browseSystemId: number | null = null;
    /** Currently-selected talkgroup id (null = all talkgroups in the chosen system). */
    browseTalkgroupId: number | null = null;
    /** Search results pulled from the server. */
    browseResults: RdioScannerCall[] = [];
    /** True between a search request and its response. */
    browseLoading = false;
    /** Total matching calls on the server (for the "X results" footer). */
    browseCount = 0;
    browseOffset = 0;
    browseError = '';

    private eventSubscription = this.rdioScannerService.event.subscribe(
        (event: RdioScannerEvent) => this.eventHandler(event),
    );

    constructor(
        private rdioScannerService: RdioScannerService,
        private cdr: ChangeDetectorRef,
    ) {}

    ngOnDestroy(): void {
        this.eventSubscription.unsubscribe();
    }

    // ---- user actions ---------------------------------------------------

    toggleLive(): void {
        if (this.livefeedOn) {
            this.rdioScannerService.stopLivefeed();
        } else {
            this.rdioScannerService.startLivefeed();
        }
    }

    togglePause(): void {
        this.rdioScannerService.pause();
    }

    replay(call: RdioScannerCall): void {
        if (call?.id !== undefined) {
            this.rdioScannerService.loadAndPlay(call.id);
        }
    }

    // ---- browse-past-calls actions -------------------------------------

    openBrowse(): void {
        this.browseOpen = true;
        if (!this.browseResults.length) {
            this.runBrowseSearch();
        }
    }

    closeBrowse(): void {
        this.browseOpen = false;
    }

    runBrowseSearch(loadMore = false): void {
        if (this.browseLoading) return;
        this.browseError = '';
        this.browseLoading = true;
        if (!loadMore) {
            this.browseOffset = 0;
        }

        const opts: RdioScannerSearchOptions = {
            limit: BROWSE_PAGE,
            offset: this.browseOffset,
            // -1 = newest first (matches the classic search default).
            sort: -1,
        };
        if (this.browseDate) {
            // <input type="date"> gives yyyy-MM-dd in local time; parse it
            // as start-of-day so the server query covers the whole day.
            const parsed = new Date(`${this.browseDate}T00:00:00`);
            if (!Number.isNaN(parsed.getTime())) {
                opts.date = parsed;
            }
        }
        if (this.browseSystemId !== null) {
            opts.system = this.browseSystemId;
        }
        if (this.browseTalkgroupId !== null) {
            opts.talkgroup = this.browseTalkgroupId;
        }
        this.rdioScannerService.searchCalls(opts);
    }

    loadMoreBrowse(): void {
        if (this.browseLoading) return;
        if (this.browseResults.length >= this.browseCount) return;
        this.browseOffset = this.browseResults.length;
        this.runBrowseSearch(true);
    }

    browseSelectionChange(): void {
        // Reset talkgroup when the system changes so we don't carry a TG
        // id that doesn't belong to the new system.
        if (this.browseTalkgroupId !== null) {
            const sys = this.config?.systems?.find((s) => s.id === this.browseSystemId);
            if (!sys?.talkgroups?.some((tg) => tg.id === this.browseTalkgroupId)) {
                this.browseTalkgroupId = null;
            }
        }
    }

    get browseSystems(): RdioScannerSystem[] {
        return this.config?.systems ?? [];
    }

    get browseTalkgroups(): RdioScannerTalkgroup[] {
        if (this.browseSystemId === null) return [];
        const sys = this.config?.systems?.find((s) => s.id === this.browseSystemId);
        return sys?.talkgroups ?? [];
    }

    formatBrowseDate(date: Date | string | undefined): string {
        if (!date) return '';
        const d = typeof date === 'string' ? new Date(date) : date;
        if (Number.isNaN(d.getTime())) return '';
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    // ---- display helpers ------------------------------------------------

    /** "HH:mm" using the user's locale, honouring the server's 12h preference. */
    formatTime(date: Date | string | undefined): string {
        if (!date) return '';
        const d = typeof date === 'string' ? new Date(date) : date;
        if (Number.isNaN(d.getTime())) return '';
        const opts: Intl.DateTimeFormatOptions = {
            hour: '2-digit',
            minute: '2-digit',
            hour12: !!this.config?.time12hFormat,
        };
        return d.toLocaleTimeString(undefined, opts);
    }

    systemLabel(call: RdioScannerCall): string {
        if (!call) return '';
        // Prefer the inlined systemData the service set on the call --
        // it's always populated for calls the listener has access to, even
        // when the listener's view of config.systems is trimmed by access
        // controls or doesn't yet include auto-populated systems.
        if (call.systemData?.label) return call.systemData.label;
        const sys = this.config?.systems?.find((s) => s.id === call.system);
        return sys?.label || `Sys ${call.system ?? '?'}`;
    }

    talkgroupLabel(call: RdioScannerCall): string {
        if (!call) return '';
        // The display name. talkgroupData.label is the short tag
        // ("Sheriff-Dispatc"); fall back to .name (the longer human name),
        // then a config lookup, then "TG <id>" as last resort.
        if (call.talkgroupData?.label) return call.talkgroupData.label;
        if (call.talkgroupData?.name) return call.talkgroupData.name;
        const sys = this.config?.systems?.find((s) => s.id === call.system);
        const tg = sys?.talkgroups?.find((t) => t.id === call.talkgroup);
        return tg?.label || tg?.name || `TG ${call.talkgroup ?? '?'}`;
    }

    /** Optional secondary line: prefer the long .name only if it adds info. */
    talkgroupName(call: RdioScannerCall): string {
        if (!call) return '';
        const label = this.talkgroupLabel(call);
        const name = call.talkgroupData?.name;
        if (name && name !== label) return name;
        return '';
    }

    talkgroupTag(call: RdioScannerCall): string {
        if (!call) return '';
        if (call.talkgroupData?.tag) return call.talkgroupData.tag;
        const sys = this.config?.systems?.find((s) => s.id === call.system);
        const tg = sys?.talkgroups?.find((t) => t.id === call.talkgroup);
        return tg?.tag || '';
    }

    trackByCall(_index: number, call: RdioScannerCall): unknown {
        return call?.id ?? call;
    }

    /** Whether a call is actively playing right now (drives the EQ animation). */
    get isPlaying(): boolean {
        return !!this.currentCall && this.livefeedOn && !this.paused;
    }

    // ---- service event firehose ----------------------------------------

    private eventHandler(event: RdioScannerEvent): void {
        if ('auth' in event && event.auth) {
            // The modern view doesn't render a PIN field; nudge the user
            // to the classic view to authenticate.
            this.needsAuth = true;
        }

        if ('config' in event) {
            this.config = event.config;
            this.branding = this.config?.branding ?? '';
            this.needsAuth = false;
        }

        if ('call' in event) {
            const incoming = event.call;
            // Whether the call just changed (new audio playing) or stopped
            // (incoming === undefined), capture what was just playing into
            // the recent feed so the user can tap to replay it.
            const departing = this.currentCall;
            if (departing && departing.id !== incoming?.id) {
                this.pushRecent(departing);
            }
            this.currentCall = incoming || undefined;
        }

        if ('livefeedMode' in event && event.livefeedMode) {
            this.livefeedOn = event.livefeedMode !== RdioScannerLivefeedMode.Offline;
        }

        if ('pause' in event) {
            this.paused = event.pause || false;
        }

        if ('listeners' in event) {
            this.listeners = event.listeners || 0;
        }

        if ('playbackList' in event && event.playbackList) {
            this.applyPlaybackList(event.playbackList);
        }

        // Most call/playback events arrive from inside Web Audio's native
        // callbacks, which sit outside Angular's NgZone. Without an
        // explicit change-detection tick the view would silently stay on
        // "Listening for the next call..." while audio is actually
        // playing. Tick on every event so the EQ animation, the
        // now-playing card, and the live/pause buttons all stay in sync.
        this.cdr.detectChanges();
    }

    private pushRecent(call: RdioScannerCall): void {
        if (!call) return;
        // Drop dupes (same id can re-arrive when livefeed restarts).
        if (this.recent.length && this.recent[0].id === call.id) return;
        this.recent.unshift(call);
        if (this.recent.length > RECENT_LIMIT) {
            this.recent.length = RECENT_LIMIT;
        }
    }

    private applyPlaybackList(list: RdioScannerPlaybackList): void {
        this.browseLoading = false;
        this.browseCount = list.count ?? 0;
        const incoming = list.results ?? [];
        // Append for paginated load-more, replace otherwise. We detect
        // "load more" by checking if the offset isn't 0.
        if (list.options?.offset && list.options.offset > 0) {
            // Avoid duplicating calls if the user hammers Load More.
            const seen = new Set(this.browseResults.map((c) => c.id));
            for (const c of incoming) {
                if (!seen.has(c.id)) this.browseResults.push(c);
            }
        } else {
            this.browseResults = incoming.slice();
        }
    }
}
