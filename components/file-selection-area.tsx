'use client';

import { useRef, useState, type PointerEvent, type ReactNode, type UIEvent } from 'react';
import { MAX_DOWNLOAD_FILES, type DownloadItem } from '@/lib/share-download';

type Point = { x: number; y: number };
type Box = { left: number; top: number; width: number; height: number };
type Gesture = { pointer: number; start: Point; client: Point; initial: DownloadItem[]; dragging: boolean };

export function FileSelectionArea({ enabled, selected, onSelection, onScroll, children }: {
  enabled: boolean;
  selected: DownloadItem[];
  onSelection: (files: DownloadItem[]) => void;
  onScroll: (event: UIEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const [box, setBox] = useState<Box | null>(null);

  function contentPoint(area: HTMLDivElement, client: Point) {
    const rect = area.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(area.clientWidth, client.x - rect.left)) + area.scrollLeft,
      y: Math.max(0, Math.min(area.clientHeight, client.y - rect.top)) + area.scrollTop,
    };
  }

  function refresh(area: HTMLDivElement, active: Gesture) {
    const end = contentPoint(area, active.client);
    const left = Math.min(active.start.x, end.x);
    const top = Math.min(active.start.y, end.y);
    const right = Math.max(active.start.x, end.x);
    const bottom = Math.max(active.start.y, end.y);
    const rect = area.getBoundingClientRect();
    const offsetX = rect.left - area.scrollLeft;
    const offsetY = rect.top - area.scrollTop;
    const files = new Map(active.initial.map(file => [file.id, file]));
    for (const marker of area.querySelectorAll<HTMLElement>('[data-select-file]')) {
      if (files.size >= MAX_DOWNLOAD_FILES) break;
      const card = marker.closest('.file-row, .selectable-media');
      const id = marker.dataset.selectFile;
      if (!card || !id || files.has(id)) continue;
      const bounds = card.getBoundingClientRect();
      if (bounds.right > left + offsetX && bounds.left < right + offsetX &&
          bounds.bottom > top + offsetY && bounds.top < bottom + offsetY) {
        files.set(id, { id, name: marker.dataset.selectName ?? 'File' });
      }
    }
    setBox({ left, top, width: right-left, height: bottom-top });
    onSelection([...files.values()]);
  }

  function start(event: PointerEvent<HTMLDivElement>) {
    suppressClick.current = false;
    if (!enabled || event.pointerType !== 'mouse' || event.button !== 0 ||
        !(event.target instanceof Element) ||
        event.target.closest('a, input, select, textarea, label, [contenteditable], button:not(.file-card):not(.media-tile)')) return;
    const client = { x: event.clientX, y: event.clientY };
    const area = event.currentTarget;
    const bounds = area.getBoundingClientRect();
    if (client.x >= bounds.left + area.clientWidth || client.y >= bounds.top + area.clientHeight) return;
    gesture.current = { pointer: event.pointerId, start: contentPoint(area, client), client, initial: selected, dragging: false };
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    const active = gesture.current;
    if (!active || active.pointer !== event.pointerId) return;
    const client = { x: event.clientX, y: event.clientY };
    if (!active.dragging) {
      if (Math.hypot(client.x-active.client.x, client.y-active.client.y) < 5) return;
      active.dragging = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    active.client = client;
    refresh(event.currentTarget, active);
  }

  function finish(event: PointerEvent<HTMLDivElement>, cancelled = false) {
    const active = gesture.current;
    if (!active || active.pointer !== event.pointerId) return;
    gesture.current = null;
    if (!active.dragging) return;
    if (cancelled) onSelection(active.initial);
    else {
      active.client = { x: event.clientX, y: event.clientY };
      refresh(event.currentTarget, active);
    }
    suppressClick.current = true;
    setBox(null);
  }

  return <div className={enabled ? 'message-area file-selection-area' : 'message-area'}
    onPointerDown={start} onPointerMove={move} onPointerUp={event => finish(event)}
    onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)}
    onPointerLeave={event => { if (!gesture.current?.dragging) finish(event, true); }}
    onDragStart={event => { if (enabled && gesture.current) event.preventDefault(); }}
    onClickCapture={event => {
      if (suppressClick.current && event.detail) {
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      }
    }}
    onScroll={event => {
      onScroll(event);
      const active = gesture.current;
      if (active?.dragging) refresh(event.currentTarget, active);
    }}>
    {children}
    {enabled && box && <span className="file-selection-box" aria-hidden="true" style={box}/>}
  </div>;

}
