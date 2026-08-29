'use client';
import { useCallback, useEffect, useRef } from 'react';
import * as maplibregl from 'maplibre-gl';
import { bandOf, pctText } from '@/lib/client';
import type { BusLive, Directive, Route, Stop } from '@/lib/types';

// MapLibre GL + OpenFreeMap dark tiles: the same engine as Mapbox (this is the
// open fork), WebGL, free and unlimited, no signup, no key.
const STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';

interface Props {
  routes: Route[];
  stops: Stop[];
  buses: BusLive[];
  directives: Directive[];
}

/**
 * Two buses standing at the same stop would render exactly on top of each other,
 * which is precisely the moment the demo needs to be legible. Fan overlapping
 * markers out around their shared point instead.
 */
function fanOut(buses: BusLive[]): Map<string, [number, number]> {
  const byPlace = new Map<string, BusLive[]>();
  for (const b of buses) {
    // ~25 m of rounding: close enough to read as "the same kerb".
    const cell = `${b.lat.toFixed(4)},${b.lng.toFixed(4)}`;
    (byPlace.get(cell) ?? byPlace.set(cell, []).get(cell)!).push(b);
  }
  const out = new Map<string, [number, number]>();
  for (const group of byPlace.values()) {
    if (group.length === 1) {
      out.set(group[0].code, [0, 0]);
      continue;
    }
    // Spread them horizontally, centred on the shared position.
    const span = 26;
    group.forEach((b, i) => {
      out.set(b.code, [(i - (group.length - 1) / 2) * span, 0]);
    });
  }
  return out;
}

export default function FleetMap({ routes, stops, buses, directives }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const markers = useRef(new Map<string, maplibregl.Marker>());
  const ready = useRef(false);
  const latest = useRef({ buses, directives });
  const initialised = useRef(false);
  const bounds = useRef<[[number, number], [number, number]] | null>(null);

  /** Create-once, then only move, recolour and re-offset — never re-create. */
  const paint = useCallback(() => {
    const m = map.current;
    if (!m || !ready.current) return;
    const { buses: fleet, directives: dirs } = latest.current;

    // Buses involved in a transfer that is actually happening right now.
    const live = dirs.filter((d) => d.status === 'pending' || d.status === 'accepted');
    const rendezvous = new Map<string, Directive>();
    for (const d of live) {
      if (!d.both_present) continue;
      rendezvous.set(d.source_code, d);
      rendezvous.set(d.target_code, d);
    }
    const pending = new Set(live.flatMap((d) => [d.source_code, d.target_code]));

    const offsets = fanOut(fleet);

    for (const bus of fleet) {
      let marker = markers.current.get(bus.code);
      if (!marker) {
        const node = document.createElement('div');
        node.className = 'bus-marker';
        node.innerHTML =
          '<span class="bus-marker__code"></span><span class="bus-marker__halo"></span>';
        node.querySelector('.bus-marker__code')!.textContent = bus.code;
        marker = new maplibregl.Marker({ element: node })
          .setLngLat([bus.lng, bus.lat])
          .setPopup(new maplibregl.Popup({ offset: 22, closeButton: false }))
          .addTo(m);
        markers.current.set(bus.code, marker);
      }

      marker.setLngLat([bus.lng, bus.lat]);
      marker.setOffset(offsets.get(bus.code) ?? [0, 0]);

      const el = marker.getElement();
      const meeting = rendezvous.has(bus.code);
      el.className =
        `bus-marker bus-marker--${bandOf(bus.pct)}` +
        (meeting ? ' bus-marker--meeting' : pending.has(bus.code) ? ' bus-marker--pending' : '');
      el.style.setProperty('--route-color', bus.route_color);

      marker.getPopup()?.setHTML(
        `<div style="font-family:ui-monospace,monospace;font-size:12px;color:#111">
           <b>Bus ${bus.code}</b> · ${bus.route_short}<br>
           ${bus.onboard}/${bus.capacity} · ${pctText(bus.pct)}
           ${meeting ? '<br><b>transferring</b>' : ''}
         </div>`
      );
    }

    // A line drawn between the two buses of every live transfer, so the judge
    // can see which pair is exchanging riders without reading the sidebar.
    const src = m.getSource('transfer-links') as maplibregl.GeoJSONSource | undefined;
    if (src) {
      const byCode = new Map(fleet.map((b) => [b.code, b]));
      src.setData({
        type: 'FeatureCollection',
        features: live.flatMap((d) => {
          const a = byCode.get(d.source_code);
          const b = byCode.get(d.target_code);
          if (!a || !b) return [];
          return [{
            type: 'Feature' as const,
            properties: { meeting: d.both_present ? 1 : 0 },
            geometry: {
              type: 'LineString' as const,
              coordinates: [[a.lng, a.lat], [b.lng, b.lat]],
            },
          }];
        }),
      });
    }
  }, []);

  // Route geometry is static — fetched from OSRM once at seed time.
  useEffect(() => {
    if (initialised.current || !container.current || !routes.length) return;
    initialised.current = true;

    const all = routes.flatMap((r) => r.line_string);
    const m = new maplibregl.Map({
      container: container.current,
      style: STYLE_URL,
      center: all[Math.floor(all.length / 2)],
      zoom: 12,
      attributionControl: { compact: true },
    });
    map.current = m;
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    m.on('error', (e) => console.error('[map]', e.error?.message ?? e));

    // `style.load`, not `load`. `load` additionally waits for a completed first
    // render, which never arrives on software renderers and would leave the
    // judge screen permanently blank.
    const initialise = () => {
      for (const route of routes) {
        m.addSource(`route-${route.id}`, {
          type: 'geojson',
          data: {
            type: 'Feature', properties: {},
            geometry: { type: 'LineString', coordinates: route.line_string },
          },
        });
        m.addLayer({
          id: `route-${route.id}-glow`, type: 'line', source: `route-${route.id}`,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': route.color, 'line-width': 10, 'line-opacity': 0.12, 'line-blur': 6 },
        });
        m.addLayer({
          id: `route-${route.id}-line`, type: 'line', source: `route-${route.id}`,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': route.color, 'line-width': 3, 'line-opacity': 0.8 },
        });
      }

      m.addSource('transfer-links', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      m.addLayer({
        id: 'transfer-link', type: 'line', source: 'transfer-links',
        layout: { 'line-cap': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-width': ['case', ['==', ['get', 'meeting'], 1], 3, 1.5],
          'line-opacity': ['case', ['==', ['get', 'meeting'], 1], 0.95, 0.4],
          'line-dasharray': [2, 1.5],
        },
      });

      // One marker per physical stop, even where several routes serve it.
      const placed = new Set<string>();
      for (const s of stops) {
        if (placed.has(s.stop_key)) continue;
        placed.add(s.stop_key);
        const node = document.createElement('div');
        node.style.cssText = 'display:flex;align-items:center';
        const dot = document.createElement('div');
        dot.className = 'stop-marker';
        const label = document.createElement('div');
        label.className = 'stop-label';
        label.textContent = s.name;
        node.append(dot, label);
        new maplibregl.Marker({ element: node, anchor: 'left' })
          .setLngLat([s.lng, s.lat]).addTo(m);
      }

      const [w, so, e, n] = all.reduce(
        (acc, c) => [Math.min(acc[0], c[0]), Math.min(acc[1], c[1]),
                     Math.max(acc[2], c[0]), Math.max(acc[3], c[1])],
        [180, 90, -180, -90]
      );
      bounds.current = [[w, so], [e, n]];

      // The style can finish before the flex/grid parent has settled on a size.
      // Fitting against a stale viewport leaves the corridor as a thumbnail in
      // the corner, so measure first, then fit.
      m.resize();
      m.fitBounds(bounds.current, { padding: 60, duration: 0 });

      ready.current = true;
      paint();
    };

    if (m.isStyleLoaded()) initialise();
    else m.once('style.load', initialise);

    // Keep the whole corridor in frame when the panel is resized.
    const observer = new ResizeObserver(() => {
      m.resize();
      if (bounds.current) m.fitBounds(bounds.current, { padding: 60, duration: 0 });
    });
    observer.observe(container.current);

    return () => {
      observer.disconnect();
      m.remove();
      map.current = null;
      markers.current = new Map();
      ready.current = false;
      initialised.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routes.length]);

  // New positions arrive every tick: stash them, then move the markers.
  useEffect(() => {
    latest.current = { buses, directives };
    paint();
  }, [buses, directives, paint]);

  return <div ref={container} className="size-full" />;
}
