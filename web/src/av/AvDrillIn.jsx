// Apollo v2 dashboard -- AV increment 5: the "All controls ›" drill-in behind
// AvCluster. Unlike the cluster's INPUT (which fires whole device scenes),
// this exposes the receiver's raw input commands plus a real diagnostics
// panel and the two query actions the Anthem module actually supports
// (input_query, power_query) -- an honest debug view, not a prettified one.
// The projector on/off toggle also lives here now (moved out of the slim
// AvCluster in increment 5 -- it's a less-common action than source/volume).

import { commands } from '../state/index.js';
import { DrillInShell, SegmentedGroup } from '../panel/DrillInShell.jsx';
import VolumeBar from './VolumeBar.jsx';

const FONT = "'Outfit', system-ui, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

// Raw receiver input commands (drill-in / debug surface) -> input number, so
// the segmented group can show which one is currently active.
const RAW_INPUTS = [
  { id: 'input_apple_tv', title: 'Apple TV', cmd: 'input_apple_tv', number: 1 },
  { id: 'input_chrome_cast', title: 'Chromecast', cmd: 'input_chrome_cast', number: 4 },
  { id: 'input_spotify_server', title: 'Spotify Server', cmd: 'input_spotify_server', number: 5 },
  { id: 'input_6', title: 'Input 6', cmd: 'input_6', number: 6 },
];

/** `lastSeenMs` -> "Ns ago", or an em dash if unknown. */
function formatSeenAgo(lastSeenMs) {
  if (typeof lastSeenMs !== 'number') return '—';
  const seconds = Math.max(0, Math.round((Date.now() - lastSeenMs) / 1000));
  return `${seconds}s ago`;
}

function DiagRow({ label, value }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 12,
        padding: '5px 0',
      }}
    >
      <span
        style={{
          fontFamily: FONT,
          fontWeight: 400,
          fontSize: 12,
          color: 'rgba(234, 229, 239, 0.4)',
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: MONO,
          fontSize: 12,
          color: 'var(--text, #eae5ef)',
          textAlign: 'right',
        }}
      >
        {value}
      </span>
    </div>
  );
}

function CardLabel({ children }) {
  return (
    <div
      style={{
        fontFamily: FONT,
        fontWeight: 500,
        fontSize: 11,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        color: 'var(--text-tertiary, rgba(234, 229, 239, 0.32))',
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

/**
 * @param {object} props
 * @param {object} props.receiverEntry - the Anthem receiver DEVICES entry
 * @param {object} [props.projectorEntry] - the projector DEVICES entry;
 *   the Projector row is omitted if not supplied
 * @param {() => void} props.onBack
 */
function AvDrillIn({ receiverEntry, projectorEntry, onBack }) {
  const live = (receiverEntry && receiverEntry.live) || {};
  const receiverOn = live.power === 'ON';

  const inputItems = RAW_INPUTS.map((input) => ({
    id: input.id,
    title: input.title,
    on: live.input === input.number,
    onToggle: () => commands.avInputRaw(receiverEntry, input.cmd, input.title),
  }));

  const reachable = live.reachable !== false;
  const projectorOn = projectorEntry ? commands.deviceView(projectorEntry).on : false;

  return (
    <DrillInShell title="AV Receiver" onBack={onBack}>
      <div
        style={{
          fontFamily: FONT,
          fontWeight: 300,
          fontSize: 11,
          color: 'var(--text-tertiary, rgba(234, 229, 239, 0.32))',
          marginTop: -12,
        }}
      >
        all functions · debug view
      </div>

      <SegmentedGroup label="Input (raw)" items={inputItems} />

      <div>
        <CardLabel>Main volume</CardLabel>
        <VolumeBar
          db={typeof live.volume === 'number' ? live.volume : -80}
          disabled={!receiverOn}
          onChange={(db) => commands.avVolume(receiverEntry, db)}
        />
      </div>

      <div>
        <button
          type="button"
          onClick={() => commands.avMute(receiverEntry)}
          style={{
            padding: '8px 14px',
            borderRadius: 'var(--r-pill, 999px)',
            border: live.mute
              ? '1px solid var(--accent, #a688e8)'
              : '1px solid rgba(234, 229, 239, 0.15)',
            background: live.mute
              ? 'var(--accent-fill, rgba(166, 136, 232, 0.16))'
              : 'rgba(234, 229, 239, 0.05)',
            color: 'var(--text, #eae5ef)',
            fontFamily: FONT,
            fontWeight: 500,
            fontSize: 12.5,
            cursor: 'pointer',
          }}
        >
          {live.mute ? 'Muted' : 'Mute'}
        </button>
      </div>

      {projectorEntry && (
        <SegmentedGroup
          label="Projector"
          items={[
            {
              id: 'on',
              title: 'On',
              on: projectorOn,
              onToggle: () =>
                commands.momentary(projectorEntry, ['on'], 'Projector on'),
            },
            {
              id: 'off',
              title: 'Off',
              on: !projectorOn,
              onToggle: () =>
                commands.momentary(projectorEntry, ['off'], 'Projector off'),
            },
          ]}
        />
      )}

      <div>
        <CardLabel>Diagnostics</CardLabel>
        <div
          style={{
            borderRadius: 'var(--r-row, 11px)',
            border: '1px solid rgba(234, 229, 239, 0.11)',
            background: 'rgba(234, 229, 239, 0.03)',
            padding: '4px 14px',
          }}
        >
          <DiagRow label="Model" value={receiverEntry.title || receiverEntry.id} />
          <DiagRow label="IP:port" value={`${receiverEntry.address}:${receiverEntry.port}`} />
          <DiagRow label="Reachable" value={reachable ? 'yes' : 'no'} />
          <DiagRow label="Last seen" value={formatSeenAgo(receiverEntry.lastSeenMs)} />
          <DiagRow label="Input #" value={typeof live.input === 'number' ? live.input : '—'} />
          <DiagRow
            label="Volume"
            value={typeof live.volume === 'number' ? `${live.volume} dB` : '—'}
          />
        </div>
      </div>

      <div>
        <CardLabel>Actions</CardLabel>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button
            type="button"
            onClick={() => commands.momentary(receiverEntry, ['power_query'], 'Receiver power query')}
            style={{
              padding: '8px 14px',
              borderRadius: 'var(--r-row, 11px)',
              border: '1px solid rgba(234, 229, 239, 0.11)',
              background: 'rgba(234, 229, 239, 0.03)',
              color: 'var(--text, #eae5ef)',
              fontFamily: FONT,
              fontWeight: 500,
              fontSize: 12.5,
              cursor: 'pointer',
            }}
          >
            Power query
          </button>
          <button
            type="button"
            onClick={() => commands.momentary(receiverEntry, ['input_query'], 'Receiver input query')}
            style={{
              padding: '8px 14px',
              borderRadius: 'var(--r-row, 11px)',
              border: '1px solid rgba(234, 229, 239, 0.11)',
              background: 'rgba(234, 229, 239, 0.03)',
              color: 'var(--text, #eae5ef)',
              fontFamily: FONT,
              fontWeight: 500,
              fontSize: 12.5,
              cursor: 'pointer',
            }}
          >
            Input query
          </button>
        </div>
        <div
          style={{
            fontFamily: FONT,
            fontWeight: 300,
            fontSize: 11,
            lineHeight: 1.5,
            color: 'var(--text-tertiary, rgba(234, 229, 239, 0.32))',
            marginTop: 8,
          }}
        >
          These re-query the receiver over serial; the response echoes back
          through the same state topic as any other update, on its normal
          delay -- not instant.
        </div>
      </div>
    </DrillInShell>
  );
}

export default AvDrillIn;
