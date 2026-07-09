// Apollo v2 dashboard -- isometric plane furniture outline.
//
// Purely decorative context rects (no labels, no interaction). Each item is
// positioned absolutely within its parent Room using plane-space coordinates.
// `kids` are nested rects (e.g. stove burners, chair legs) positioned
// relative to their parent item's own box.

const OUTLINE = '1px solid rgba(234,229,239,.28)';
const FILL = 'rgba(234,229,239,.05)';

function rectStyle(item) {
  return {
    position: 'absolute',
    left: `${item.x}px`,
    top: `${item.y}px`,
    width: `${item.w}px`,
    height: `${item.h}px`,
    border: OUTLINE,
    background: FILL,
    borderRadius: item.r,
    transform: `rotate(${item.rot || '0deg'})`,
    boxSizing: 'border-box',
  };
}

/**
 * @param {{ item: object }} props
 */
export default function Furniture({ item }) {
  return (
    <div class="plan-furniture" style={rectStyle(item)}>
      {(item.kids || []).map((kid, i) => (
        <div key={i} class="plan-furniture__kid" style={rectStyle(kid)} />
      ))}
    </div>
  );
}
