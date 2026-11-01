// A small box-shaped car as an inline glTF, so no third-party model is needed. +Y is up, -Z is the front (glTF convention).
const BOXES = [
  // [center x, y, z], [size x, y, z]: body, then cabin.
  [[0, 0.45, 0], [1.8, 0.6, 4.4]],
  [[0, 1.05, 0.2], [1.6, 0.6, 2.2]],
];
const FACES = [
  [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
  [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
];

function geometry() {
  const positions = [], normals = [], indices = [];
  for (const [center, size] of BOXES) {
    for (const [n, u, v] of FACES) {
      const start = positions.length / 3;
      for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        for (let k = 0; k < 3; k++) {
          positions.push(center[k] + (n[k] + u[k] * su + v[k] * sv) * size[k] / 2);
          normals.push(n[k]);
        }
      }
      indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
    }
  }
  return { positions, normals, indices };
}

export function vehicleGltf() {
  const { positions, normals, indices } = geometry();
  const count = positions.length / 3;
  const index = new Uint16Array(indices);
  const position = new Float32Array(positions);
  const normal = new Float32Array(normals);
  const bytes = new Uint8Array(index.byteLength + (index.byteLength % 4 ? 2 : 0) + position.byteLength + normal.byteLength);
  const positionOffset = index.byteLength + (index.byteLength % 4 ? 2 : 0);
  bytes.set(new Uint8Array(index.buffer), 0);
  bytes.set(new Uint8Array(position.buffer), positionOffset);
  bytes.set(new Uint8Array(normal.buffer), positionOffset + position.byteLength);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const axis = k => positions.filter((_, i) => i % 3 === k);
  return {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 1, NORMAL: 2 }, indices: 0, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.8 } }],
    buffers: [{ byteLength: bytes.length, uri: `data:application/octet-stream;base64,${btoa(binary)}` }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: index.byteLength, target: 34963 },
      { buffer: 0, byteOffset: positionOffset, byteLength: position.byteLength, target: 34962 },
      { buffer: 0, byteOffset: positionOffset + position.byteLength, byteLength: normal.byteLength, target: 34962 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5123, count: index.length, type: 'SCALAR' },
      { bufferView: 1, componentType: 5126, count, type: 'VEC3', min: [0, 1, 2].map(k => Math.min(...axis(k))), max: [0, 1, 2].map(k => Math.max(...axis(k))) },
      { bufferView: 2, componentType: 5126, count, type: 'VEC3' },
    ],
  };
}
