window.AeroTwin3D = (function () {
  let scene, camera, renderer, controls, raycaster, mouse;
  let acGroup, blowerMesh, louverMesh, evaporatorMesh, drainPanWaterMesh;
  let cfdParticles, cfdPositions, cfdVelocities;
  let hotspotSprites = [];
  let isXray = false;
  let isCfdActive = true;
  let currentAcType = 'split';
  let clock = new THREE.Clock();

  const HOTSPOT_DATA = [
    {
      id: 'esp32c3',
      position: new THREE.Vector3(1.55, 0.35, 0.55),
      tag: 'MCU CORE NODE',
      title: 'ESP32-C3 SuperMini (RISC-V 160MHz)',
      desc: 'Board utama pengendali HVAC dengan ukuran ultra-kompak (22.5x18mm). Menjalankan stack Wi-Fi/BLE, RMT IR transceiver 38kHz, RS485 Modbus RTU, dan Watchdog hardware.',
      metric: 'GPIO4: IR TX | GPIO6/7: RS485 | VBUS: 5.02V'
    },
    {
      id: 'ds18b20',
      position: new THREE.Vector3(-0.6, 0.3, 0.48),
      tag: 'GPIO2 (1-WIRE BUS)',
      title: 'Dual Probe DS18B20 Return & Supply',
      desc: 'Mengukur suhu udara masuk (Return) dan suhu hembusan evaporator (Supply) secara simultan untuk menghitung efisiensi termodinamika Delta-T secara real-time.',
      metric: 'Resolusi: 12-bit (0.0625°C) | Polling: 1000ms'
    },
    {
      id: 'sct013',
      position: new THREE.Vector3(1.65, -0.25, 0.25),
      tag: 'GPIO0 (ADC1_CH0)',
      title: 'Current Transformer Non-Invasif SCT-013',
      desc: 'Membaca gelombang arus beban kompresor dan kipas indoor secara true-RMS untuk mendeteksi lonjakan inrush current dan menghitung konsumsi daya aktif (Watt).',
      metric: 'Rasio: 30A/1V | Sampling: 2.0 kSPS'
    },
    {
      id: 'mpu6050',
      position: new THREE.Vector3(-1.35, 0.0, 0.2),
      tag: 'GPIO8/9 (I2C BUS)',
      title: 'Sensor Vibrasi MEMS & BME280',
      desc: 'Terpasang pada sasis bracket dan jalur pipa refrigeran untuk mendeteksi ketidakseimbangan bearing blower atau kavitasi kompresor sebelum terjadi kerusakan fatal.',
      metric: 'Ambang Aman: < 2.5 mm/s RMS'
    },
    {
      id: 'drain',
      position: new THREE.Vector3(0.9, -0.48, 0.5),
      tag: 'GPIO1 (ADC / FLOAT)',
      title: 'Sensor Level Air Kondensasi & Panen Distilasi',
      desc: 'Memonitor tinggi permukaan air kondensasi di baki drainase untuk mencegah kebocoran air ke ruang server/kantor serta menghitung volume air distilasi yang dipanen.',
      metric: 'Kapasitas Panen: ~6.8 Liter/Hari'
    }
  ];

  function init(containerId) {
    const container = document.getElementById(containerId);
    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(42, container.clientWidth / container.clientHeight, 0.1, 100);
    camera.position.set(3.2, 1.6, 4.4);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.maxDistance = 12;
    controls.minDistance = 1.8;

    // Studio & Technical CAD Lighting
    const ambientLight = new THREE.AmbientLight(0xdbeafe, 0.75);
    scene.add(ambientLight);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.15);
    keyLight.position.set(5, 8, 6);
    scene.add(keyLight);

    const rimLight = new THREE.PointLight(0x10b981, 1.1, 12);
    rimLight.position.set(-4, 2, -3);
    scene.add(rimLight);

    // Subtle Floor Reference Grid
    const grid = new THREE.GridHelper(10, 20, 0x1e293b, 0x0f172a);
    grid.position.y = -1.65;
    scene.add(grid);

    raycaster = new THREE.Raycaster();
    mouse = new THREE.Vector2();

    acGroup = new THREE.Group();
    scene.add(acGroup);

    buildAcGeometry('split');
    initCfdParticles();
    createHotspots();

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', onWindowResize);

    animate();
  }

  function createMaterials() {
    const shellOpacity = isXray ? 0.22 : 0.96;
    return {
      casing: new THREE.MeshPhysicalMaterial({
        color: 0x1e293b,
        metalness: 0.35,
        roughness: 0.25,
        transparent: true,
        opacity: shellOpacity
      }),
      frameWire: new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: isXray ? 0.55 : 0.18 }),
      copperCoil: new THREE.MeshStandardMaterial({ color: 0xd97706, metalness: 0.85, roughness: 0.2 }),
      coolingFin: new THREE.MeshStandardMaterial({
        color: 0x06b6d4,
        emissive: 0x0891b2,
        emissiveIntensity: 0.35,
        metalness: 0.6,
        roughness: 0.3
      }),
      blower: new THREE.MeshStandardMaterial({ color: 0x10b981, metalness: 0.5, roughness: 0.3 }),
      louver: new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.4, roughness: 0.2 }),
      espBoard: new THREE.MeshStandardMaterial({ color: 0x059669, emissive: 0x065f46, emissiveIntensity: 0.5 }),
      water: new THREE.MeshStandardMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.65 })
    };
  }

  function buildAcGeometry(type) {
    currentAcType = type;
    while (acGroup.children.length > 0) {
      acGroup.remove(acGroup.children[0]);
    }

    const mat = createMaterials();

    if (type === 'split') {
      // Outer Wall-Mounted Split Shell
      const shellGeo = new THREE.BoxGeometry(3.4, 1.05, 0.95);
      const shell = new THREE.Mesh(shellGeo, mat.casing);
      acGroup.add(shell);
      acGroup.add(new THREE.LineSegments(new THREE.EdgesGeometry(shellGeo), mat.frameWire));

      // Internal Multi-Pass Copper Evaporator Coil
      evaporatorMesh = new THREE.Group();
      for (let i = -3; i <= 3; i++) {
        const tubeGeo = new THREE.CylinderGeometry(0.032, 0.032, 2.95, 16);
        tubeGeo.rotateZ(Math.PI / 2);
        const tube = new THREE.Mesh(tubeGeo, i % 2 === 0 ? mat.copperCoil : mat.coolingFin);
        tube.position.set(0, 0.18 + i * 0.06, 0.05);
        evaporatorMesh.add(tube);
      }
      acGroup.add(evaporatorMesh);

      // Cross-Flow Tangential Rotor Fan
      const rotorGeo = new THREE.CylinderGeometry(0.18, 0.18, 2.8, 16, 1, false);
      rotorGeo.rotateZ(Math.PI / 2);
      blowerMesh = new THREE.Mesh(rotorGeo, mat.blower);
      blowerMesh.position.set(0, -0.12, -0.05);
      acGroup.add(blowerMesh);

      // Motorized Swing Louver Blade
      const louverGeo = new THREE.BoxGeometry(3.15, 0.04, 0.22);
      louverMesh = new THREE.Mesh(louverGeo, mat.louver);
      louverMesh.position.set(0, -0.45, 0.44);
      louverMesh.rotation.x = THREE.MathUtils.degToRad(45);
      acGroup.add(louverMesh);

    } else if (type === 'cassette') {
      // 4-Way Ceiling Cassette Architecture
      const shellGeo = new THREE.BoxGeometry(2.8, 0.65, 2.8);
      const shell = new THREE.Mesh(shellGeo, mat.casing);
      acGroup.add(shell);
      acGroup.add(new THREE.LineSegments(new THREE.EdgesGeometry(shellGeo), mat.frameWire));

      const ringGeo = new THREE.TorusGeometry(0.88, 0.08, 16, 48);
      ringGeo.rotateX(Math.PI / 2);
      evaporatorMesh = new THREE.Mesh(ringGeo, mat.coolingFin);
      acGroup.add(evaporatorMesh);

      const turboGeo = new THREE.CylinderGeometry(0.55, 0.65, 0.35, 20);
      blowerMesh = new THREE.Mesh(turboGeo, mat.blower);
      acGroup.add(blowerMesh);

      louverMesh = new THREE.Group();
      const bladeGeo = new THREE.BoxGeometry(1.8, 0.03, 0.16);
      const b1 = new THREE.Mesh(bladeGeo, mat.louver);
      b1.position.set(0, -0.34, 1.15);
      louverMesh.add(b1);
      acGroup.add(louverMesh);

    } else if (type === 'crac') {
      // Data Center Floor Standing CRAC Precision Unit
      const shellGeo = new THREE.BoxGeometry(2.1, 2.75, 1.15);
      const shell = new THREE.Mesh(shellGeo, mat.casing);
      acGroup.add(shell);
      acGroup.add(new THREE.LineSegments(new THREE.EdgesGeometry(shellGeo), mat.frameWire));

      const coilGeo = new THREE.BoxGeometry(1.75, 1.1, 0.25);
      evaporatorMesh = new THREE.Mesh(coilGeo, mat.coolingFin);
      evaporatorMesh.position.set(0, 0.45, 0);
      acGroup.add(evaporatorMesh);

      const fanGeo = new THREE.CylinderGeometry(0.45, 0.45, 0.3, 20);
      fanGeo.rotateX(Math.PI / 2);
      blowerMesh = new THREE.Mesh(fanGeo, mat.blower);
      blowerMesh.position.set(0, -0.65, 0.15);
      acGroup.add(blowerMesh);

      const grilleGeo = new THREE.BoxGeometry(1.8, 0.12, 0.3);
      louverMesh = new THREE.Mesh(grilleGeo, mat.louver);
      louverMesh.position.set(0, -1.1, 0.48);
      acGroup.add(louverMesh);

    } else if (type === 'vrf') {
      // Industrial Central VRF Ducted Handler
      const shellGeo = new THREE.BoxGeometry(3.5, 1.15, 1.65);
      const shell = new THREE.Mesh(shellGeo, mat.casing);
      acGroup.add(shell);
      acGroup.add(new THREE.LineSegments(new THREE.EdgesGeometry(shellGeo), mat.frameWire));

      evaporatorMesh = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.85, 0.3), mat.coolingFin);
      evaporatorMesh.position.set(0, 0, 0.25);
      acGroup.add(evaporatorMesh);

      const twinBlowerGeo = new THREE.CylinderGeometry(0.32, 0.32, 2.5, 18);
      twinBlowerGeo.rotateZ(Math.PI / 2);
      blowerMesh = new THREE.Mesh(twinBlowerGeo, mat.blower);
      blowerMesh.position.set(0, 0, -0.35);
      acGroup.add(blowerMesh);

      louverMesh = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.08, 0.3), mat.louver);
      louverMesh.position.set(0, -0.3, 0.78);
      acGroup.add(louverMesh);
    }

    // Condensate Water Pan Level Indicator
    const panGeo = new THREE.BoxGeometry(2.6, 0.06, 0.35);
    drainPanWaterMesh = new THREE.Mesh(panGeo, mat.water);
    drainPanWaterMesh.position.set(0, -0.48, 0.25);
    acGroup.add(drainPanWaterMesh);

    // Embedded ESP32-C3 SuperMini 3D Module inside Unit
    const espGeo = new THREE.BoxGeometry(0.28, 0.36, 0.08);
    const espMesh = new THREE.Mesh(espGeo, mat.espBoard);
    espMesh.position.copy(HOTSPOT_DATA[0].position);
    acGroup.add(espMesh);
  }

  function initCfdParticles() {
    const count = 260;
    const geometry = new THREE.BufferGeometry();
    cfdPositions = new Float32Array(count * 3);
    cfdVelocities = [];

    for (let i = 0; i < count; i++) {
      cfdPositions[i * 3] = (Math.random() - 0.5) * 2.8;
      cfdPositions[i * 3 + 1] = -0.45 - Math.random() * 1.1;
      cfdPositions[i * 3 + 2] = 0.45 + Math.random() * 1.6;
      cfdVelocities.push({
        vy: -(0.012 + Math.random() * 0.018),
        vz: 0.018 + Math.random() * 0.025
      });
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(cfdPositions, 3));
    const material = new THREE.PointsMaterial({
      color: 0x22d3ee,
      size: 0.065,
      transparent: true,
      opacity: 0.8
    });

    cfdParticles = new THREE.Points(geometry, material);
    scene.add(cfdParticles);
  }

  function createHotspots() {
    hotspotSprites.forEach((s) => scene.remove(s));
    hotspotSprites = [];

    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.beginPath();
    ctx.arc(32, 32, 22, 0, Math.PI * 2);
    ctx.fillStyle = '#10b981';
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();

    const tex = new THREE.CanvasTexture(canvas);

    HOTSPOT_DATA.forEach((hs) => {
      const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
      const sprite = new THREE.Sprite(mat);
      sprite.position.copy(hs.position);
      sprite.scale.set(0.24, 0.24, 1);
      sprite.userData = hs;
      scene.add(sprite);
      hotspotSprites.push(sprite);
    });
  }

  function onPointerDown(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(hotspotSprites);
    if (intersects.length > 0) {
      const data = intersects[0].object.userData;
      const card = document.getElementById('hotspot-card');
      document.getElementById('hs-tag').textContent = data.tag;
      document.getElementById('hs-title').textContent = data.title;
      document.getElementById('hs-desc').textContent = data.desc;
      document.getElementById('hs-metric').textContent = data.metric;
      card.classList.remove('hidden');
    }
  }

  function animate() {
    requestAnimationFrame(animate);
    const dt = clock.getDelta();
    const state = window.AeroApp ? window.AeroApp.getState() : { power: true, fanSpeed: 3, louverAngle: 45, fault: 'normal' };

    if (blowerMesh && state.power) {
      const speedFactor = state.fanSpeed * 4.5;
      if (currentAcType === 'cassette') {
        blowerMesh.rotation.y += dt * speedFactor;
      } else {
        blowerMesh.rotation.x += dt * speedFactor;
      }
    }

    if (louverMesh) {
      louverMesh.rotation.x = THREE.MathUtils.degToRad(state.louverAngle);
    }

    // Update CFD Thermal Airflow Streamlines
    if (cfdParticles) {
      cfdParticles.visible = isCfdActive && state.power;
      if (cfdParticles.visible) {
        const pos = cfdParticles.geometry.attributes.position.array;
        const angleRad = THREE.MathUtils.degToRad(state.louverAngle);
        for (let i = 0; i < cfdVelocities.length; i++) {
          pos[i * 3 + 1] += cfdVelocities[i].vy * Math.sin(angleRad) * (state.fanSpeed * 0.45);
          pos[i * 3 + 2] += cfdVelocities[i].vz * Math.cos(angleRad) * (state.fanSpeed * 0.45);

          if (pos[i * 3 + 2] > 2.4 || pos[i * 3 + 1] < -1.6) {
            pos[i * 3] = (Math.random() - 0.5) * 2.8;
            pos[i * 3 + 1] = -0.42;
            pos[i * 3 + 2] = 0.45;
          }
        }
        cfdParticles.geometry.attributes.position.needsUpdate = true;

        // Fault color cue on CFD Streamlines
        if (state.fault === 'low_freon') {
          cfdParticles.material.color.setHex(0xf59e0b);
        } else if (state.fault === 'drain_overflow') {
          cfdParticles.material.color.setHex(0xf43f5e);
        } else {
          cfdParticles.material.color.setHex(0x22d3ee);
        }
      }
    }

    controls.update();
    renderer.render(scene, camera);
  }

  function onWindowResize() {
    const container = document.getElementById('canvas-container');
    if (!container) return;
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  }

  return {
    init,
    setAcType: function (type) {
      buildAcGeometry(type);
    },
    setXray: function (enabled) {
      isXray = enabled;
      buildAcGeometry(currentAcType);
    },
    setCfd: function (enabled) {
      isCfdActive = enabled;
    },
    resetCamera: function () {
      camera.position.set(3.2, 1.6, 4.4);
      controls.target.set(0, 0, 0);
    }
  };
})();
