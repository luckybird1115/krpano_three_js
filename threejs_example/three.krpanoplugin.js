/*
	krpano ThreeJS example plugin
	- use three.js inside krpano
	- with stereo-rendering and WebVR support
	- with 3d object hit-testing (onover, onout, onup, ondown, onclick) and mouse cursor handling
*/

function krpanoplugin()
{
	var local  = this;
	var krpano = null;
	var device = null;
	var plugin = null;


	local.registerplugin = function(krpanointerface, pluginpath, pluginobject)
	{
		krpano = krpanointerface;
		device = krpano.device;
		plugin = pluginobject;

		if (krpano.version < "1.19")
		{
			krpano.trace(3,"ThreeJS plugin - too old krpano version (min. 1.19)");
			return;
		}

		if (!device.webgl)
		{
			// show warning
			krpano.trace(2,"ThreeJS plugin - WebGL required");
			return;
		}

		krpano.debugmode = true;
		krpano.trace(0, "ThreeJS krpano plugin");

		// load the requiered three.js scripts
		load_scripts(["three.min.js"], start);
	}

	local.unloadplugin = function()
	{
		// no unloading support at the moment
	}

	local.onresize = function(width, height)
	{
		return false;
	}


	function resolve_url_path(url)
	{
		if (url.charAt(0) != "/" && url.indexOf("://") < 0)
		{
			// adjust relative url path
			url = krpano.parsepath("%CURRENTXML%/" + url);
		}

		return url;
	}


	function load_scripts(urls, callback)
	{
		if (urls.length > 0)
		{
			var url = resolve_url_path( urls.splice(0,1)[0] );

			var script = document.createElement("script");
			script.src = url;
			script.addEventListener("load", function(){ load_scripts(urls,callback); });
			script.addEventListener("error", function(){ krpano.trace(3,"loading file '"+url+"' failed!"); });
			document.getElementsByTagName("head")[0].appendChild(script);
		}
		else
		{
			// done
			callback();
		}
	}


	// helper
	var M_RAD = Math.PI / 180.0;


	// ThreeJS/krpano objects
	var renderer = null;
	var scene = null;
	var camera = null;
	var stereocamera = null;
	var camera_hittest_raycaster = null;
	var krpano_panoview = null;
	var krpano_panoview_euler = null;
	var krpano_projection = new Float32Array(16);		// krpano projection matrix
	var krpano_depthbuffer_scale = 1.0001;				// depthbuffer scaling (use ThreeJS defaults: znear=0.1, zfar=2000)
	var krpano_depthbuffer_offset = -0.2;


	function start()
	{
		// create the ThreeJS WebGL renderer, but use the WebGL context from krpano
		renderer = new THREE.WebGLRenderer({canvas:krpano.webGL.canvas, context:krpano.webGL.context});
		renderer.autoClear = false;
		renderer.setPixelRatio(1);	// krpano handles the pixel ratio scaling

		// restore the krpano WebGL settings (for correct krpano rendering)
		restore_krpano_WebGL_state();

		// use the krpano onviewchanged event as render-frame callback (this event will be directly called after the krpano pano rendering)
		krpano.set("events[__threejs__].keep", true);
		krpano.set("events[__threejs__].onviewchange", adjust_krpano_rendering);	// correct krpano view settings before the rendering
		krpano.set("events[__threejs__].onviewchanged", render_frame);

		// enable continuous rendering (that means render every frame, not just when the view has changed)
		krpano.view.continuousupdates = true;

		// register mouse and touch events
		if (device.browser.events.mouse)
		{
			krpano.control.layer.addEventListener("mousedown", handle_mouse_touch_events, true);
		}
		if (device.browser.events.touch)
		{
			krpano.control.layer.addEventListener(device.browser.events.touchstart, handle_mouse_touch_events, true);
		}

		// basic ThreeJS objects
		scene = new THREE.Scene();
		camera = new THREE.Camera();
		stereocamera = new THREE.Camera();
		camera_hittest_raycaster = new THREE.Raycaster();
		krpano_panoview_euler = new THREE.Euler();

		// build the ThreeJS scene (start adding custom code there)
		build_scene();
		
		// restore the krpano WebGL settings (for correct krpano rendering)
		restore_krpano_WebGL_state();
	}


	function restore_krpano_WebGL_state()
	{
		var gl = krpano.webGL.context;

		gl.disable(gl.DEPTH_TEST);
		gl.cullFace(gl.FRONT);
		gl.frontFace(gl.CCW);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
		gl.activeTexture(gl.TEXTURE0);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
		gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
		
		// restore the current krpano WebGL program
		krpano.webGL.restoreProgram();
		
		//renderer.resetGLState();
	}


	function restore_ThreeJS_WebGL_state()
	{
		var gl = krpano.webGL.context;

		gl.enable(gl.DEPTH_TEST);
		gl.depthFunc(gl.LEQUAL);
		gl.enable(gl.CULL_FACE);
		gl.cullFace(gl.BACK);
		gl.clearDepth(1);
		gl.clear(gl.DEPTH_BUFFER_BIT);

		renderer.resetGLState();
	}


	function krpano_projection_matrix(sw,sh, zoom, xoff,yoff)
	{
		var m = krpano_projection;

		var pr = device.pixelratio;
		sw = pr / (sw*0.5);
		sh = pr / (sh*0.5);

		m[0]  = zoom*sw;    m[1]  = 0;          m[2]  = 0;                          m[3]  = 0;
		m[4]  = 0;          m[5]  = -zoom*sh;   m[6]  = 0;                          m[7]  = 0;
		m[8]  = xoff;       m[9]  = -yoff*sh;   m[10] = krpano_depthbuffer_scale;   m[11] = 1;
		m[12] = 0;          m[13] = 0;          m[14] = krpano_depthbuffer_offset;  m[15] = 1;
	}


	function update_camera_matrix(camera)
	{
		var m = krpano_projection;
		camera.projectionMatrix.set(m[0],m[4],m[8],m[12], m[1],m[5],m[9],m[13], m[2],m[6],m[10],m[14], m[3],m[7],m[11],m[15]);
	}


	function adjust_krpano_rendering()
	{
		if (krpano.view.fisheye != 0.0)
		{
			// disable the fisheye distortion, ThreeJS objects can't be rendered with it
			krpano.view.fisheye = 0.0;
		}
	}


	function render_frame()
	{
		var gl = krpano.webGL.context;
		var vr = krpano.webVR && krpano.webVR.enabled ? krpano.webVR : null;

		var sw = gl.drawingBufferWidth;
		var sh = gl.drawingBufferHeight;


		// setup WebGL for ThreeJS
		restore_ThreeJS_WebGL_state();

		// set the camera/view rotation
		krpano_panoview = krpano.view.getState(krpano_panoview);	// the 'krpano_panoview' object will be created and cached inside getState()
		krpano_panoview_euler.set(-krpano_panoview.v * M_RAD, (krpano_panoview.h-90) * M_RAD, krpano_panoview.r * M_RAD, "YXZ");
		camera.quaternion.setFromEuler(krpano_panoview_euler);
		camera.updateMatrixWorld(true);

		// set the camera/view projection
		krpano_projection_matrix(sw,sh, krpano_panoview.z, 0, krpano_panoview.yf);
		update_camera_matrix(camera);


		// do scene updates
		update_scene();


		// render the scene
		if (krpano.display.stereo == false)
		{
			// normal rendering
			renderer.setViewport(0,0, sw,sh);
			renderer.render(scene, camera);
		}
		else
		{
			// stereo / VR rendering
			sw *= 0.5;	// use half screen width

			var stereo_scale = 0.05;
			var stereo_offset = Number(krpano.display.stereooverlap);

			// use a different camera for stereo rendering to keep the normal one for hit-testing
			stereocamera.quaternion.copy(camera.quaternion);
			stereocamera.updateMatrixWorld(true);

			// render left eye
			var eye_offset = -0.03;
			krpano_projection_matrix(sw,sh, krpano_panoview.z, stereo_offset, krpano_panoview.yf);

			if (vr)
			{
				eye_offset = vr.eyetranslt(1);						// get the eye offset (from the WebVR API)
				vr.prjmatrix(1, krpano_projection);					// replace the projection matrix (with the one from WebVR)
				krpano_projection[10] = krpano_depthbuffer_scale;	// adjust the depthbuffer scaling
				krpano_projection[14] = krpano_depthbuffer_offset;
			}

			// add the eye offset
			krpano_projection[12] = krpano_projection[0] * -eye_offset * stereo_scale;

			update_camera_matrix(stereocamera);
			renderer.setViewport(0,0, sw,sh);
			renderer.render(scene, stereocamera);

			// render right eye
			eye_offset = +0.03;
			krpano_projection[8] = -stereo_offset;	// mod the projection matrix (only change the stereo offset)

			if (vr)
			{
				eye_offset = vr.eyetranslt(2);						// get the eye offset (from the WebVR API)
				vr.prjmatrix(2, krpano_projection);					// replace the projection matrix (with the one from WebVR)
				krpano_projection[10] = krpano_depthbuffer_scale;	// adjust the depthbuffer scaling
				krpano_projection[14] = krpano_depthbuffer_offset;
			}

			// add the eye offset
			krpano_projection[12] = krpano_projection[0] * -eye_offset * stereo_scale;

			update_camera_matrix(stereocamera);
			renderer.setViewport(sw,0, sw,sh);
			renderer.render(scene, stereocamera);
		}

		// important - restore the krpano WebGL state for correct krpano rendering
		restore_krpano_WebGL_state();
	}



	// -----------------------------------------------------------------------
	// ThreeJS User Content - START HERE

	var clock = null;
	var animatedobjects = [];
	var box = null;


	// add a krpano hotspot like handling for the 3d objects
	function assign_object_properties(obj, name, properties)
	{
		// set defaults (krpano hotspot like properties)
		if (properties          === undefined)	properties         = {};
		if (properties.name     === undefined)	properties.name    = name;
		if (properties.ath      === undefined)	properties.ath     = 0;
		if (properties.atv      === undefined)	properties.atv     = 0;
		if (properties.depth    === undefined)	properties.depth   = 1000;
		if (properties.scale    === undefined)	properties.scale   = 1;
		if (properties.rx       === undefined)	properties.rx      = 0;
		if (properties.ry       === undefined)	properties.ry      = 0;
		if (properties.rz       === undefined)	properties.rz      = 0;
		if (properties.rorder   === undefined)	properties.rorder  = "YXZ";
		if (properties.enabled  === undefined)	properties.enabled = true;
		if (properties.capture  === undefined)	properties.capture = true;
		if (properties.onover   === undefined)	properties.onover  = null;
		if (properties.onout    === undefined)	properties.onout   = null;
		if (properties.ondown   === undefined)	properties.ondown  = null;
		if (properties.onup     === undefined)	properties.onup    = null;
		if (properties.onclick  === undefined)	properties.onclick = null;
		properties.pressed  = false;
		properties.hovering = false;

		obj.properties = properties;

		update_object_properties(obj);
	}


	function update_object_properties(obj)
	{
		var p = obj.properties;

		var px = p.depth * Math.cos(p.atv * M_RAD)*Math.cos((180-p.ath) * M_RAD);
		var py = p.depth * Math.sin(p.atv * M_RAD);
		var pz = p.depth * Math.cos(p.atv * M_RAD)*Math.sin((180-p.ath) * M_RAD);
		obj.position.set(px,py,pz);

		obj.rotation.set(p.rx*M_RAD, p.ry*M_RAD, p.rz*M_RAD, p.rorder);

		obj.scale.set(p.scale, p.scale, p.scale);

		obj.updateMatrix();
	}


	function load_object_json(url, animated, properties, donecall)
	{
		url = resolve_url_path(url);

		var loader = new THREE.JSONLoader();
		loader.load(url, function (geometry, materials)
		{
			var material = materials[0];

			if (animated)
			{
				material.morphTargets = true;
				material.morphNormals = true;
				geometry.computeMorphNormals();
			}

			geometry.computeVertexNormals();

			var obj = new THREE.MorphAnimMesh(geometry, material);

			if (animated)
			{
				obj.duration = 1000;
				obj.time = 0;
				obj.matrixAutoUpdate = false;

				animatedobjects.push(obj);
			}

			assign_object_properties(obj, url, properties);

			scene.add( obj );

			if (donecall)
			{
				donecall(obj);
			}

		});
	}


	function build_scene()
	{
		clock = new THREE.Clock();

		// load 3d objects
		load_object_json("monster.js",  true, {ath:+30,  atv:+15, depth:500,  scale:0.1, rx:180, ry:60  ,rz:0,   ondown:function(obj){ obj.properties.scale *= 1.2; update_object_properties(obj); }, onup:function(obj){ obj.properties.scale /= 1.2; update_object_properties(obj); }});
		load_object_json("flamingo.js", true, {ath:-110, atv:-20, depth:700,  scale:1.0, rx:-10, ry:250, rz:180, ondown:function(obj){ obj.properties.scale *= 1.2; update_object_properties(obj); }, onup:function(obj){ obj.properties.scale /= 1.2; update_object_properties(obj); }});
		load_object_json("horse.js",    true, {ath:-58,  atv:+7,  depth:1000, scale:1.0, rx:180, ry:233, rz:0,   ondown:function(obj){ obj.properties.scale *= 1.2; update_object_properties(obj); }, onup:function(obj){ obj.properties.scale /= 1.2; update_object_properties(obj); }}, function(obj){ obj.material.color.setHex(0xAA5522); } );

		// create a textured 3d box
		box = new THREE.Mesh(new THREE.BoxGeometry(500,500,500), new THREE.MeshBasicMaterial({map:THREE.ImageUtils.loadTexture(resolve_url_path("box.jpg"))}));
		assign_object_properties(box, "box", {ath:160, atv:-3, depth:2000, ondown:function(obj){ obj.properties.scale *= 1.2; }, onup:function(obj){ obj.properties.scale /= 1.2; }});
		scene.add( box );

		// add scene lights
		scene.add( new THREE.AmbientLight(0x333333) );

		var directionalLight = new THREE.DirectionalLight(0xFFFFFF);
		directionalLight.position.x = 0.5;
		directionalLight.position.y = -1;
		directionalLight.position.z = 0;
		directionalLight.position.normalize();
		scene.add( directionalLight );
	}


	function do_object_hittest(mx, my)
	{
		var mouse_x = (mx / krpano.area.pixelwidth)  * 2.0 - 1.0;
		var mouse_y = (my / krpano.area.pixelheight) * 2.0 - 1.0;

		if (krpano.display.stereo)
		{
			mouse_x += (mouse_x < 0.0 ? +1 : -1) * (1.0 - Number(krpano.display.stereooverlap)) * 0.5;
		}

		camera_hittest_raycaster.ray.direction.set(mouse_x, -mouse_y, 1.0).unproject(camera).normalize();

		var intersects = camera_hittest_raycaster.intersectObjects( scene.children );
		var i;
		var obj;

		for (i=0; i < intersects.length; i++)
		{
			obj = intersects[i].object;
			if (obj && obj.properties && obj.properties.enabled)
			{
				return obj;
			}
		}

		return null;
	}


	var handle_mouse_hitobject = null;

	function handle_mouse_touch_events(event)
	{
		var type = "";

		if (event.type == "mousedown")
		{
			type = "ondown";
			krpano.control.layer.addEventListener("mouseup", handle_mouse_touch_events, true);
		}
		else if (event.type == "mouseup")
		{
			type = "onup";
			krpano.control.layer.removeEventListener("mouseup", handle_mouse_touch_events, true);
		}
		else if (event.type == device.browser.events.touchstart)
		{
			type = "ondown";
			krpano.control.layer.addEventListener(device.browser.events.touchend, handle_mouse_touch_events, true);
		}
		else if (event.type == device.browser.events.touchend)
		{
			type = "onup";
			krpano.control.layer.removeEventListener(device.browser.events.touchend, handle_mouse_touch_events, true);
		}

		// get mouse / touch pos
		var ms = krpano.control.getMousePos(event.changedTouches ? event.changedTouches[0] : event);
		ms.x /= krpano.stagescale;
		ms.y /= krpano.stagescale;

		// is there a object as that pos?
		var hitobj = do_object_hittest(ms.x, ms.y);

		if (type == "ondown")
		{
			if (hitobj)
			{
				handle_mouse_hitobject = hitobj;

				hitobj.properties.pressed = true;

				if (hitobj.properties.ondown)
				{
					hitobj.properties.ondown(hitobj);
				}

				if (hitobj.properties.capture)
				{
					krpano.mouse.down = true;
					event.stopPropagation();
				}

				event.preventDefault();
			}
		}
		else if (type == "onup")
		{
			if (handle_mouse_hitobject && handle_mouse_hitobject.properties.enabled)
			{
				if (handle_mouse_hitobject.properties.pressed)
				{
					handle_mouse_hitobject.properties.pressed = false;

					if (handle_mouse_hitobject.properties.onup)
					{
						handle_mouse_hitobject.properties.onup(handle_mouse_hitobject);
					}
				}

				if (handle_mouse_hitobject.properties.onclick)
				{
					if ( hitobj == handle_mouse_hitobject )
					{
						handle_mouse_hitobject.properties.onclick(handle_mouse_hitobject);
					}
				}
			}

			krpano.mouse.down = false;
		}
	}


	function handle_mouse_hovering()
	{
		// check mouse over state
		if (krpano.mouse.down == false)		// currently not dragging?
		{
			var hitobj = do_object_hittest(krpano.mouse.x, krpano.mouse.y);

			if (hitobj != handle_mouse_hitobject)
			{
				if (handle_mouse_hitobject)
				{
					handle_mouse_hitobject.properties.hovering = false;
					if (handle_mouse_hitobject.properties.onout)	handle_mouse_hitobject.properties.onout(handle_mouse_hitobject);
				}

				if (hitobj)
				{
					hitobj.properties.hovering = true;
					if (hitobj.properties.onover)	hitobj.properties.onover(hitobj);
				}

				handle_mouse_hitobject = hitobj;
			}

			if (handle_mouse_hitobject)// || (krpano.display.stereo == false && krpano.display.hotspotrenderer != "webgl"))
			{
				krpano.control.layer.style.cursor = krpano.cursors.hit;
			}
			else
			{
				krpano.cursors.update();
			}
		}
	}


	function update_scene()
	{
		// animate objects
		var delta = clock.getDelta();

		if (box)
		{
			box.properties.rx += 50 * delta;
			box.properties.ry += 10 * delta;
			update_object_properties(box);
		}

		for (var i=0; i < animatedobjects.length; i++)
		{
			animatedobjects[i].updateAnimation(1000 * delta);
		}

		handle_mouse_hovering();
	}
}
