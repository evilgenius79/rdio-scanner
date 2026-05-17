/*
 * *****************************************************************************
 * Copyright (C) 2019-2026 Chrystian Huot <chrystian.huot@saubeo.solutions>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>
 * ****************************************************************************
 */

import { Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { MatSidenav } from '@angular/material/sidenav';
import { MatSnackBar } from '@angular/material/snack-bar';
import { timer } from 'rxjs';
import { RdioScannerEvent, RdioScannerLivefeedMode } from './rdio-scanner';
import { RdioScannerService } from './rdio-scanner.service';
import { RdioScannerNativeComponent } from './native/native.component';

@Component({
    selector: 'rdio-scanner',
    styleUrls: ['./rdio-scanner.component.scss'],
    templateUrl: './rdio-scanner.component.html',
})
export class RdioScannerComponent implements OnDestroy, OnInit {
    private eventSubscription = this.rdioScannerService.event.subscribe((event: RdioScannerEvent) => this.eventHandler(event));

    private livefeedMode: RdioScannerLivefeedMode = RdioScannerLivefeedMode.Offline;

    // We wait for the first config push from the server before deciding
    // whether to show the native-app prompt. Tracked here so we only fire
    // the timer once per page load.
    private nativePromptScheduled = false;

    @ViewChild('searchPanel') private searchPanel: MatSidenav | undefined;

    @ViewChild('selectPanel') private selectPanel: MatSidenav | undefined;

    constructor(
        private matSnackBar: MatSnackBar,
        private ngElementRef: ElementRef,
        private rdioScannerService: RdioScannerService,
    ) { }

    @HostListener('window:beforeunload', ['$event'])
    exitNotification(event: BeforeUnloadEvent): void {
        if (this.livefeedMode !== RdioScannerLivefeedMode.Offline) {
            event.preventDefault();

            event.returnValue = 'Live Feed is ON, do you really want to leave?';
        }
    }

    ngOnDestroy(): void {
        this.eventSubscription.unsubscribe();
    }

    ngOnInit(): void {
        // The native-app prompt is now scheduled inside eventHandler() once
        // we've seen the server's config and confirmed showNativeAppPrompt
        // is enabled. Upstream's hard-coded 10-second timer would fire even
        // if the operator turned the prompt off; gating on the option means
        // a fresh fork can disable it without patching out code.
        //
        // Upstream's "RED TAPE" comment asked downstream forks not to
        // disable the prompt because it harms the native-app project.
        // This fork makes the prompt opt-out via Admin -> Options ->
        // "Show native-app prompt" (default ON, preserving upstream
        // behaviour). Operators who choose to disable it on their install
        // are doing so knowingly; the code path is still here for
        // upstream-style deployments.
    }

    scrollTop(e: HTMLElement): void {
        setTimeout(() => e.scrollTo(0, 0));
    }

    start(): void {
        this.rdioScannerService.startLivefeed();
    }

    stop(): void {
        this.rdioScannerService.stopLivefeed();

        this.searchPanel?.close();
        this.selectPanel?.close();
    }

    toggleFullscreen(): void {
        if (document.fullscreenElement) {
            const el: {
                exitFullscreen?: () => void;
                mozCancelFullScreen?: () => void;
                msExitFullscreen?: () => void;
                webkitExitFullscreen?: () => void;
            } = document;

            if (el.exitFullscreen) {
                el.exitFullscreen();

            } else if (el.mozCancelFullScreen) {
                el.mozCancelFullScreen();

            } else if (el.msExitFullscreen) {
                el.msExitFullscreen();

            } else if (el.webkitExitFullscreen) {
                el.webkitExitFullscreen();
            }

        } else {
            const el = this.ngElementRef.nativeElement;

            if (el.requestFullscreen) {
                el.requestFullscreen();

            } else if (el.mozRequestFullScreen) {
                el.mozRequestFullScreen();

            } else if (el.msRequestFullscreen) {
                el.msRequestFullscreen();

            } else if (el.webkitRequestFullscreen) {
                el.webkitRequestFullscreen();
            }
        }
    }

    private eventHandler(event: RdioScannerEvent): void {
        if (event.livefeedMode) {
            this.livefeedMode = event.livefeedMode;
        }

        if (event.config && !this.nativePromptScheduled) {
            this.nativePromptScheduled = true;

            // Default-true semantics: if the field is missing from the
            // payload (older server, or a custom downstream that hasn't
            // wired it through yet), keep showing the prompt so we don't
            // silently break the upstream contract.
            const showPrompt = event.config.showNativeAppPrompt !== false;
            if (!showPrompt) {
                return;
            }

            timer(10000).subscribe(() => {
                const ua: string = navigator.userAgent;
                if (ua.includes('Android') || ua.includes('iPad') || ua.includes('iPhone')) {
                    this.matSnackBar.openFromComponent(RdioScannerNativeComponent, { panelClass: 'snackbar-white' });
                }
            });
        }
    }
}
