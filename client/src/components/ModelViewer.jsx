import React, { useEffect, useRef, useState } from 'react';

// 3D model viewer (GLB / glTF) with rotate + zoom, WebGL, lazy-loaded Three.js.
// If WebGL is unavailable the viewer says so instead of pretending to render.
export default function ModelViewer({ url, height = 320 }) {
  const mountRef = useRef(null);
  const stateRef = useRef({});
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};

    (async () => {
      try {
        const THREE = await import('three');
        const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
        const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js');
        if (disposed || !mountRef.current) return;

        const mount = mountRef.current;
        const width = mount.clientWidth || 480;

        let renderer;
        try {
          renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        } catch {
          setStatus('unsupported');
          setError('WebGL is not available in this browser, so the 3D model cannot be displayed.');
          return;
        }
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(width, height);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        mount.innerHTML = '';
        mount.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        scene.background = new THREE.Color('#0a120c');
        const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 2000);
        camera.position.set(0, 0.6, 2.6);

        scene.add(new THREE.AmbientLight(0xffffff, 1.1));
        const key = new THREE.DirectionalLight(0x9dffc4, 2.0);
        key.position.set(2, 3, 2);
        scene.add(key);
        const rim = new THREE.DirectionalLight(0x35ff8b, 1.0);
        rim.position.set(-2, -1, -2);
        scene.add(rim);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.enablePan = false;
        controls.minDistance = 0.4;
        controls.maxDistance = 20;

        const loader = new GLTFLoader();
        loader.load(
          url,
          (gltf) => {
            if (disposed) return;
            const model = gltf.scene;
            const box = new THREE.Box3().setFromObject(model);
            const size = box.getSize(new THREE.Vector3());
            const center = box.getCenter(new THREE.Vector3());
            model.position.sub(center);
            const maxDim = Math.max(size.x, size.y, size.z) || 1;
            const fit = maxDim / (2 * Math.tan((camera.fov * Math.PI) / 360));
            camera.position.set(0, maxDim * 0.25, fit * 2.4);
            controls.target.set(0, 0, 0);
            controls.update();
            scene.add(model);
            setStatus('ready');
          },
          undefined,
          () => {
            if (disposed) return;
            setStatus('error');
            setError('This 3D model could not be loaded. It may be corrupted or not a valid GLB/glTF file.');
          }
        );

        let frame = 0;
        const animate = () => {
          frame = requestAnimationFrame(animate);
          controls.update();
          renderer.render(scene, camera);
        };
        animate();

        const onResize = () => {
          const nextWidth = mount.clientWidth || width;
          camera.aspect = nextWidth / height;
          camera.updateProjectionMatrix();
          renderer.setSize(nextWidth, height);
        };
        window.addEventListener('resize', onResize);

        stateRef.current = { THREE, scene, renderer, controls, camera };

        cleanup = () => {
          cancelAnimationFrame(frame);
          window.removeEventListener('resize', onResize);
          controls.dispose();
          scene.traverse((object) => {
            if (object.geometry) object.geometry.dispose();
            if (object.material) {
              const materials = Array.isArray(object.material) ? object.material : [object.material];
              materials.forEach((material) => {
                Object.values(material).forEach((value) => {
                  if (value && value.isTexture) value.dispose();
                });
                material.dispose();
              });
            }
          });
          renderer.dispose();
          if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
        };
      } catch (err) {
        if (!disposed) {
          setStatus('error');
          setError(err.message || '3D viewer failed to start.');
        }
      }
    })();

    return () => {
      disposed = true;
      cleanup();
    };
  }, [url, height]);

  function resetView() {
    const { controls, camera } = stateRef.current;
    if (!controls || !camera) return;
    camera.position.set(0, 0.6, 2.6);
    controls.target.set(0, 0, 0);
    controls.update();
  }

  return (
    <div className="model-viewer">
      <div ref={mountRef} style={{ width: '100%', height, borderRadius: 12, overflow: 'hidden', background: '#0a120c' }} />
      {status === 'loading' ? <div className="model-hint">Loading 3D model…</div> : null}
      {status === 'ready' ? <div className="model-hint">Drag to rotate · Scroll or pinch to zoom</div> : null}
      {status === 'error' || status === 'unsupported' ? <div className="model-hint error-text">{error}</div> : null}
      {status === 'ready' ? (
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn ghost sm" onClick={resetView}>Reset view</button>
          <a className="btn ghost sm" href={url} download>Download model</a>
        </div>
      ) : null}
    </div>
  );
}
