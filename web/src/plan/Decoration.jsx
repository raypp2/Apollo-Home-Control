// Apollo v2 dashboard -- isometric plane decoration rect.
//
// Decorations are floorplan labels for non-interactive spaces (closets) --
// schema v2's `decorative: true` entries in config/rooms.json. They carry a
// `rect` and a `label` and nothing else: no furniture, no fixtures, no
// selection. Rendered as a faint dashed box, dimmer than a real plan-room,
// with pointer-events disabled so they can never be tapped or intercept
// hover/click meant for the rooms underneath or beside them.

/**
 * @param {{ decoration: object }} props
 */
export default function Decoration({ decoration }) {
  const style = {
    left: `${decoration.rect.x}px`,
    top: `${decoration.rect.y}px`,
    width: `${decoration.rect.w}px`,
    height: `${decoration.rect.h}px`,
  };

  return (
    <div class="plan-decoration" style={style}>
      <div class="plan-decoration__label">{decoration.label}</div>
    </div>
  );
}
