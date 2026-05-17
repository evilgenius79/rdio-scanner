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
} from '../rdio-scanner';
import { RdioScannerService } from '../rdio-scanner.service';

const RECENT_LIMIT = 100;

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
}
