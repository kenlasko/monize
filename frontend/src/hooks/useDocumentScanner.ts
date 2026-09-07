'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  createScannerClient,
  type ScannerClient,
  type WorkerFactory,
} from '@/lib/document-scanner/document-scan-client';
import { decodeImageFile } from '@/lib/document-scanner/decode-image';
import type {
  Quad,
  RawImage,
  ScanResult,
} from '@/lib/document-scanner/document-scan.types';

/**
 * Owns the scanner worker for as long as a dialog is open, and makes sure the
 * result on screen belongs to the photo currently on screen.
 *
 * The client already drops replies to requests it has forgotten; this adds the
 * half only the UI knows about -- which request is the CURRENT one. A user who
 * retakes a photo while the first scan is still running has two in flight, and
 * the first one's answer, arriving second, would otherwise replace the second
 * one's preview with the wrong document (`I6`).
 */

export type ScannerStatus = 'idle' | 'loading' | 'ready' | 'failed';

export interface DocumentScannerState {
  status: ScannerStatus;
  /** The decoded photo the current result was produced from. */
  source: RawImage | null;
  result: ScanResult | null;
  error: string | null;
}

export interface UseDocumentScanner extends DocumentScannerState {
  /** Decode a picked file and scan it. */
  scan(file: File): Promise<void>;
  /** Re-warp the current photo with corners the user moved. */
  rewarp(quad: Quad, rotation: 0 | 1 | 2 | 3): Promise<void>;
  /** Forget the current photo and result, leaving the worker alive. */
  reset(): void;
}

export function useDocumentScanner(
  createWorker?: WorkerFactory,
): UseDocumentScanner {
  const clientRef = useRef<ScannerClient | null>(null);
  const sourceRef = useRef<RawImage | null>(null);
  /**
   * Which attempt is current. Incremented by every scan and every reset, so a
   * reply captured under an older value is known to be stale without needing
   * to know why it is stale.
   */
  const attemptRef = useRef(0);
  const mountedRef = useRef(true);

  const [state, setState] = useState<DocumentScannerState>({
    status: 'idle',
    source: null,
    result: null,
    error: null,
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clientRef.current?.dispose();
      clientRef.current = null;
    };
  }, []);

  const client = useCallback((): ScannerClient => {
    if (!clientRef.current) {
      clientRef.current = createScannerClient(createWorker);
    }
    return clientRef.current;
  }, [createWorker]);

  /** Apply an update only if the attempt that produced it is still current. */
  const commit = useCallback(
    (attempt: number, next: Partial<DocumentScannerState>): void => {
      if (!mountedRef.current || attempt !== attemptRef.current) return;
      setState((previous) => ({ ...previous, ...next }));
    },
    [],
  );

  const scan = useCallback(
    async (file: File): Promise<void> => {
      const attempt = ++attemptRef.current;
      setState({ status: 'loading', source: null, result: null, error: null });
      try {
        const image = await decodeImageFile(file);
        if (attempt !== attemptRef.current) return;
        sourceRef.current = image;
        const result = await client().scan(image);
        commit(attempt, {
          status: 'ready',
          source: image,
          result,
          error: null,
        });
      } catch (error) {
        commit(attempt, {
          status: 'failed',
          error:
            error instanceof Error
              ? error.message
              : 'The document could not be scanned',
        });
      }
    },
    [client, commit],
  );

  const rewarp = useCallback(
    async (quad: Quad, rotation: 0 | 1 | 2 | 3): Promise<void> => {
      const image = sourceRef.current;
      if (!image) return;
      // Deliberately NOT a new attempt: a re-warp refines the photo already on
      // screen, so a scan of a different photo landing meanwhile still wins.
      const attempt = attemptRef.current;
      try {
        const result = await client().rewarp(image, quad, rotation);
        commit(attempt, { status: 'ready', result, error: null });
      } catch (error) {
        commit(attempt, {
          status: 'failed',
          error:
            error instanceof Error
              ? error.message
              : 'The document could not be scanned',
        });
      }
    },
    [client, commit],
  );

  const reset = useCallback((): void => {
    attemptRef.current++;
    sourceRef.current = null;
    setState({ status: 'idle', source: null, result: null, error: null });
  }, []);

  return { ...state, scan, rewarp, reset };
}
