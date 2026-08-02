var Ig=Object.defineProperty;var Eg=(e,t,r)=>t in e?Ig(e,t,{enumerable:!0,configurable:!0,writable:!0,value:r}):e[t]=r;var Js=(e,t,r)=>Eg(e,typeof t!="symbol"?t+"":t,r);var Ca=Object.defineProperty,zg=Object.getOwnPropertyDescriptor,Cg=Object.getOwnPropertyNames,Ag=Object.prototype.hasOwnProperty,Og=(e=>typeof require<"u"?require:typeof Proxy<"u"?new Proxy(e,{get:(t,r)=>(typeof require<"u"?require:t)[r]}):e)(function(e){if(typeof require<"u")return require.apply(this,arguments);throw Error('Dynamic require of "'+e+'" is not supported')}),U=(e,t)=>()=>(e&&(t=e(e=0)),t),Gt=(e,t)=>{for(var r in t)Ca(e,r,{get:t[r],enumerable:!0})},Rg=(e,t,r,i)=>{if(t&&typeof t=="object"||typeof t=="function")for(let a of Cg(t))!Ag.call(e,a)&&a!==r&&Ca(e,a,{get:()=>t[a],enumerable:!(i=zg(t,a))||i.enumerable});return e},pr=e=>Rg(Ca({},"__esModule",{value:!0}),e),Xt,ft,qt,eo,Bd,Nd=U(()=>{Xt=new Map,ft=[],qt=(e,t,r)=>{if(t&&typeof t.init=="function"&&typeof t.createInferenceSessionHandler=="function"){let i=Xt.get(e);if(i===void 0)Xt.set(e,{backend:t,priority:r});else{if(i.priority>r)return;if(i.priority===r&&i.backend!==t)throw new Error(`cannot register backend "${e}" using priority ${r}`)}if(r>=0){let a=ft.indexOf(e);a!==-1&&ft.splice(a,1);for(let s=0;s<ft.length;s++)if(Xt.get(ft[s]).priority<=r){ft.splice(s,0,e);return}ft.push(e)}return}throw new TypeError("not a valid backend")},eo=async e=>{let t=Xt.get(e);if(!t)return"backend not found.";if(t.initialized)return t.backend;if(t.aborted)return t.error;{let r=!!t.initPromise;try{return r||(t.initPromise=t.backend.init(e)),await t.initPromise,t.initialized=!0,t.backend}catch(i){return r||(t.error=`${i}`,t.aborted=!0),t.error}finally{delete t.initPromise}}},Bd=async e=>{let t=e.executionProviders||[],r=t.map(l=>typeof l=="string"?l:l.name),i=r.length===0?ft:r,a,s=[],n=new Set;for(let l of i){let p=await eo(l);typeof p=="string"?s.push({name:l,err:p}):(a||(a=p),a===p&&n.add(l))}if(!a)throw new Error(`no available backend found. ERR: ${s.map(l=>`[${l.name}] ${l.err}`).join(", ")}`);for(let{name:l,err:p}of s)r.includes(l)&&console.warn(`removing requested execution provider "${l}" from session options because it is not available: ${p}`);let u=t.filter(l=>n.has(typeof l=="string"?l:l.name));return[a,new Proxy(e,{get:(l,p)=>p==="executionProviders"?u:Reflect.get(l,p)})]}}),Bg=U(()=>{Nd()}),Md,Ng=U(()=>{Md="1.27.0"}),_i,Ie,Dd=U(()=>{Ng(),_i="warning",Ie={wasm:{},webgl:{},webgpu:{},versions:{common:Md},set logLevel(e){if(e!==void 0){if(typeof e!="string"||["verbose","info","warning","error","fatal"].indexOf(e)===-1)throw new Error(`Unsupported logging level: ${e}`);_i=e}},get logLevel(){return _i}},Object.defineProperty(Ie,"logLevel",{enumerable:!0})}),we,Mg=U(()=>{Dd(),we=Ie}),Ud,Pd,Dg=U(()=>{Ud=(e,t)=>{let r=typeof document<"u"?document.createElement("canvas"):new OffscreenCanvas(1,1);r.width=e.dims[3],r.height=e.dims[2];let i=r.getContext("2d");if(i!=null){let a,s;(t==null?void 0:t.tensorLayout)!==void 0&&t.tensorLayout==="NHWC"?(a=e.dims[2],s=e.dims[3]):(a=e.dims[3],s=e.dims[2]);let n=(t==null?void 0:t.format)!==void 0?t.format:"RGB",u=t==null?void 0:t.norm,l,p;u===void 0||u.mean===void 0?l=[255,255,255,255]:typeof u.mean=="number"?l=[u.mean,u.mean,u.mean,u.mean]:(l=[u.mean[0],u.mean[1],u.mean[2],0],u.mean[3]!==void 0&&(l[3]=u.mean[3])),u===void 0||u.bias===void 0?p=[0,0,0,0]:typeof u.bias=="number"?p=[u.bias,u.bias,u.bias,u.bias]:(p=[u.bias[0],u.bias[1],u.bias[2],0],u.bias[3]!==void 0&&(p[3]=u.bias[3]));let h=s*a,m=0,g=h,y=h*2,_=-1;n==="RGBA"?(m=0,g=h,y=h*2,_=h*3):n==="RGB"?(m=0,g=h,y=h*2):n==="RBG"&&(m=0,y=h,g=h*2);for(let b=0;b<s;b++)for(let S=0;S<a;S++){let v=(e.data[m++]-p[0])*l[0],w=(e.data[g++]-p[1])*l[1],I=(e.data[y++]-p[2])*l[2],k=_===-1?255:(e.data[_++]-p[3])*l[3];i.fillStyle="rgba("+v+","+w+","+I+","+k+")",i.fillRect(S,b,1,1)}if("toDataURL"in r)return r.toDataURL();throw new Error("toDataURL is not supported")}else throw new Error("Can not access image data")},Pd=(e,t)=>{let r=typeof document<"u"?document.createElement("canvas").getContext("2d"):new OffscreenCanvas(1,1).getContext("2d"),i;if(r!=null){let a,s,n;(t==null?void 0:t.tensorLayout)!==void 0&&t.tensorLayout==="NHWC"?(a=e.dims[2],s=e.dims[1],n=e.dims[3]):(a=e.dims[3],s=e.dims[2],n=e.dims[1]);let u=t!==void 0&&t.format!==void 0?t.format:"RGB",l=t==null?void 0:t.norm,p,h;l===void 0||l.mean===void 0?p=[255,255,255,255]:typeof l.mean=="number"?p=[l.mean,l.mean,l.mean,l.mean]:(p=[l.mean[0],l.mean[1],l.mean[2],255],l.mean[3]!==void 0&&(p[3]=l.mean[3])),l===void 0||l.bias===void 0?h=[0,0,0,0]:typeof l.bias=="number"?h=[l.bias,l.bias,l.bias,l.bias]:(h=[l.bias[0],l.bias[1],l.bias[2],0],l.bias[3]!==void 0&&(h[3]=l.bias[3]));let m=s*a;if(t!==void 0&&(t.format!==void 0&&n===4&&t.format!=="RGBA"||n===3&&t.format!=="RGB"&&t.format!=="BGR"))throw new Error("Tensor format doesn't match input tensor dims");let g=4,y=0,_=1,b=2,S=3,v=0,w=m,I=m*2,k=-1;u==="RGBA"?(v=0,w=m,I=m*2,k=m*3):u==="RGB"?(v=0,w=m,I=m*2):u==="RBG"&&(v=0,I=m,w=m*2),i=r.createImageData(a,s);for(let E=0;E<s*a;y+=g,_+=g,b+=g,S+=g,E++)i.data[y]=(e.data[v++]-h[0])*p[0],i.data[_]=(e.data[w++]-h[1])*p[1],i.data[b]=(e.data[I++]-h[2])*p[2],i.data[S]=k===-1?255:(e.data[k++]-h[3])*p[3]}else throw new Error("Can not access image data");return i}}),Tr,qd,Ld,Wd,Vd,Gd,Ug=U(()=>{Aa(),Tr=(e,t)=>{var k,E,A;if(e===void 0)throw new Error("Image buffer must be defined");if(t.height===void 0||t.width===void 0)throw new Error("Image height and width must be defined");if(t.tensorLayout==="NHWC")throw new Error("NHWC Tensor layout is not supported yet");let{height:r,width:i}=t,a=(k=t.norm)!=null?k:{mean:255,bias:0},s,n;typeof a.mean=="number"?s=[a.mean,a.mean,a.mean,a.mean]:s=[a.mean[0],a.mean[1],a.mean[2],(E=a.mean[3])!=null?E:255],typeof a.bias=="number"?n=[a.bias,a.bias,a.bias,a.bias]:n=[a.bias[0],a.bias[1],a.bias[2],(A=a.bias[3])!=null?A:0];let u=t.format!==void 0?t.format:"RGBA",l=t.tensorFormat!==void 0&&t.tensorFormat!==void 0?t.tensorFormat:"RGB",p=r*i,h=l==="RGBA"?new Float32Array(p*4):new Float32Array(p*3),m=4,g=0,y=1,_=2,b=3,S=0,v=p,w=p*2,I=-1;u==="RGB"&&(m=3,g=0,y=1,_=2,b=-1),l==="RGBA"?I=p*3:l==="RBG"?(S=0,w=p,v=p*2):l==="BGR"&&(w=0,v=p,S=p*2);for(let C=0;C<p;C++,g+=m,_+=m,y+=m,b+=m)h[S++]=(e[g]+n[0])/s[0],h[v++]=(e[y]+n[1])/s[1],h[w++]=(e[_]+n[2])/s[2],I!==-1&&b!==-1&&(h[I++]=(e[b]+n[3])/s[3]);return l==="RGBA"?new Ue("float32",h,[1,4,r,i]):new Ue("float32",h,[1,3,r,i])},qd=async(e,t)=>{let r=typeof HTMLImageElement<"u"&&e instanceof HTMLImageElement,i=typeof ImageData<"u"&&e instanceof ImageData,a=typeof ImageBitmap<"u"&&e instanceof ImageBitmap,s=typeof e=="string",n,u=t!=null?t:{},l=()=>{if(typeof document<"u")return document.createElement("canvas");if(typeof OffscreenCanvas<"u")return new OffscreenCanvas(1,1);throw new Error("Canvas is not supported")},p=h=>typeof HTMLCanvasElement<"u"&&h instanceof HTMLCanvasElement||h instanceof OffscreenCanvas?h.getContext("2d"):null;if(r){let h=l();h.width=e.width,h.height=e.height;let m=p(h);if(m!=null){let g=e.height,y=e.width;if(t!==void 0&&t.resizedHeight!==void 0&&t.resizedWidth!==void 0&&(g=t.resizedHeight,y=t.resizedWidth),t!==void 0){if(u=t,t.tensorFormat!==void 0)throw new Error("Image input config format must be RGBA for HTMLImageElement");u.tensorFormat="RGBA",u.height=g,u.width=y}else u.tensorFormat="RGBA",u.height=g,u.width=y;m.drawImage(e,0,0),n=m.getImageData(0,0,y,g).data}else throw new Error("Can not access image data")}else if(i){let h,m;if(t!==void 0&&t.resizedWidth!==void 0&&t.resizedHeight!==void 0?(h=t.resizedHeight,m=t.resizedWidth):(h=e.height,m=e.width),t!==void 0&&(u=t),u.format="RGBA",u.height=h,u.width=m,t!==void 0){let g=l();g.width=m,g.height=h;let y=p(g);if(y!=null)y.putImageData(e,0,0),n=y.getImageData(0,0,m,h).data;else throw new Error("Can not access image data")}else n=e.data}else if(a){if(t===void 0)throw new Error("Please provide image config with format for Imagebitmap");let h=l();h.width=e.width,h.height=e.height;let m=p(h);if(m!=null){let g=e.height,y=e.width;return m.drawImage(e,0,0,y,g),n=m.getImageData(0,0,y,g).data,u.height=g,u.width=y,Tr(n,u)}else throw new Error("Can not access image data")}else{if(s)return new Promise((h,m)=>{let g=l(),y=p(g);if(!e||!y)return m();let _=new Image;_.crossOrigin="Anonymous",_.src=e,_.onload=()=>{g.width=_.width,g.height=_.height,y.drawImage(_,0,0,g.width,g.height);let b=y.getImageData(0,0,g.width,g.height);u.height=g.height,u.width=g.width,h(Tr(b.data,u))}});throw new Error("Input data provided is not supported - aborted tensor creation")}if(n!==void 0)return Tr(n,u);throw new Error("Input data provided is not supported - aborted tensor creation")},Ld=(e,t)=>{let{width:r,height:i,download:a,dispose:s}=t,n=[1,i,r,4];return new Ue({location:"texture",type:"float32",texture:e,dims:n,download:a,dispose:s})},Wd=(e,t)=>{let{dataType:r,dims:i,download:a,dispose:s}=t;return new Ue({location:"gpu-buffer",type:r!=null?r:"float32",gpuBuffer:e,dims:i,download:a,dispose:s})},Vd=(e,t)=>{let{dataType:r,dims:i,download:a,dispose:s}=t;return new Ue({location:"ml-tensor",type:r!=null?r:"float32",mlTensor:e,dims:i,download:a,dispose:s})},Gd=(e,t,r)=>new Ue({location:"cpu-pinned",type:e,data:t,dims:r!=null?r:[t.length]})}),It,sr,bi,Hd,Pg=U(()=>{It=new Map([["float32",Float32Array],["uint8",Uint8Array],["int8",Int8Array],["uint16",Uint16Array],["int16",Int16Array],["int32",Int32Array],["bool",Uint8Array],["float64",Float64Array],["uint32",Uint32Array],["int4",Uint8Array],["uint4",Uint8Array]]),sr=new Map([[Float32Array,"float32"],[Uint8Array,"uint8"],[Int8Array,"int8"],[Uint16Array,"uint16"],[Int16Array,"int16"],[Int32Array,"int32"],[Float64Array,"float64"],[Uint32Array,"uint32"]]),bi=!1,Hd=()=>{if(!bi){bi=!0;let e=typeof BigInt64Array<"u"&&BigInt64Array.from,t=typeof BigUint64Array<"u"&&BigUint64Array.from,r=globalThis.Float16Array,i=typeof r<"u"&&r.from;e&&(It.set("int64",BigInt64Array),sr.set(BigInt64Array,"int64")),t&&(It.set("uint64",BigUint64Array),sr.set(BigUint64Array,"uint64")),i?(It.set("float16",r),sr.set(r,"float16")):It.set("float16",Uint16Array)}}}),Fd,jd,qg=U(()=>{Aa(),Fd=e=>{let t=1;for(let r=0;r<e.length;r++){let i=e[r];if(typeof i!="number"||!Number.isSafeInteger(i))throw new TypeError(`dims[${r}] must be an integer, got: ${i}`);if(i<0)throw new RangeError(`dims[${r}] must be a non-negative integer, got: ${i}`);t*=i}return t},jd=(e,t)=>{switch(e.location){case"cpu":return new Ue(e.type,e.data,t);case"cpu-pinned":return new Ue({location:"cpu-pinned",data:e.data,type:e.type,dims:t});case"texture":return new Ue({location:"texture",texture:e.texture,type:e.type,dims:t});case"gpu-buffer":return new Ue({location:"gpu-buffer",gpuBuffer:e.gpuBuffer,type:e.type,dims:t});case"ml-tensor":return new Ue({location:"ml-tensor",mlTensor:e.mlTensor,type:e.type,dims:t});default:throw new Error(`tensorReshape: tensor location ${e.location} is not supported`)}}}),Ue,Aa=U(()=>{Dg(),Ug(),Pg(),qg(),Ue=class{constructor(e,t,r){Hd();let i,a;if(typeof e=="object"&&"location"in e)switch(this.dataLocation=e.location,i=e.type,a=e.dims,e.location){case"cpu-pinned":{let n=It.get(i);if(!n)throw new TypeError(`unsupported type "${i}" to create tensor from pinned buffer`);if(!(e.data instanceof n))throw new TypeError(`buffer should be of type ${n.name}`);this.cpuData=e.data;break}case"texture":{if(i!=="float32")throw new TypeError(`unsupported type "${i}" to create tensor from texture`);this.gpuTextureData=e.texture,this.downloader=e.download,this.disposer=e.dispose;break}case"gpu-buffer":{if(i!=="float32"&&i!=="float16"&&i!=="int32"&&i!=="int64"&&i!=="uint32"&&i!=="uint8"&&i!=="bool"&&i!=="uint4"&&i!=="int4")throw new TypeError(`unsupported type "${i}" to create tensor from gpu buffer`);this.gpuBufferData=e.gpuBuffer,this.downloader=e.download,this.disposer=e.dispose;break}case"ml-tensor":{if(i!=="float32"&&i!=="float16"&&i!=="int32"&&i!=="int64"&&i!=="uint32"&&i!=="uint64"&&i!=="int8"&&i!=="uint8"&&i!=="bool"&&i!=="uint4"&&i!=="int4")throw new TypeError(`unsupported type "${i}" to create tensor from MLTensor`);this.mlTensorData=e.mlTensor,this.downloader=e.download,this.disposer=e.dispose;break}default:throw new Error(`Tensor constructor: unsupported location '${this.dataLocation}'`)}else{let n,u;if(typeof e=="string")if(i=e,u=r,e==="string"){if(!Array.isArray(t))throw new TypeError("A string tensor's data must be a string array.");n=t}else{let l=It.get(e);if(l===void 0)throw new TypeError(`Unsupported tensor type: ${e}.`);if(Array.isArray(t)){if(e==="float16"&&l===Uint16Array||e==="uint4"||e==="int4")throw new TypeError(`Creating a ${e} tensor from number array is not supported. Please use ${l.name} as data.`);e==="uint64"||e==="int64"?n=l.from(t,BigInt):n=l.from(t)}else if(t instanceof l)n=t;else if(t instanceof Uint8ClampedArray)if(e==="uint8")n=Uint8Array.from(t);else throw new TypeError("A Uint8ClampedArray tensor's data must be type of uint8");else if(e==="float16"&&t instanceof Uint16Array&&l!==Uint16Array)n=new globalThis.Float16Array(t.buffer,t.byteOffset,t.length);else throw new TypeError(`A ${i} tensor's data must be type of ${l}`)}else if(u=t,Array.isArray(e)){if(e.length===0)throw new TypeError("Tensor type cannot be inferred from an empty array.");let l=typeof e[0];if(l==="string")i="string",n=e;else if(l==="boolean")i="bool",n=Uint8Array.from(e);else throw new TypeError(`Invalid element type of data array: ${l}.`)}else if(e instanceof Uint8ClampedArray)i="uint8",n=Uint8Array.from(e);else{let l=sr.get(e.constructor);if(l===void 0)throw new TypeError(`Unsupported type for tensor data: ${e.constructor}.`);i=l,n=e}if(u===void 0)u=[n.length];else if(!Array.isArray(u))throw new TypeError("A tensor's dims must be a number array");a=u,this.cpuData=n,this.dataLocation="cpu"}let s=Fd(a);if(this.cpuData&&s!==this.cpuData.length&&!((i==="uint4"||i==="int4")&&Math.ceil(s/2)===this.cpuData.length))throw new Error(`Tensor's size(${s}) does not match data length(${this.cpuData.length}).`);this.type=i,this.dims=a,this.size=s}static async fromImage(e,t){return qd(e,t)}static fromTexture(e,t){return Ld(e,t)}static fromGpuBuffer(e,t){return Wd(e,t)}static fromMLTensor(e,t){return Vd(e,t)}static fromPinnedBuffer(e,t,r){return Gd(e,t,r)}toDataURL(e){return Ud(this,e)}toImageData(e){return Pd(this,e)}get data(){if(this.ensureValid(),!this.cpuData)throw new Error("The data is not on CPU. Use `getData()` to download GPU data to CPU, or use `texture` or `gpuBuffer` property to access the GPU data directly.");return this.cpuData}get location(){return this.dataLocation}get texture(){if(this.ensureValid(),!this.gpuTextureData)throw new Error("The data is not stored as a WebGL texture.");return this.gpuTextureData}get gpuBuffer(){if(this.ensureValid(),!this.gpuBufferData)throw new Error("The data is not stored as a WebGPU buffer.");return this.gpuBufferData}get mlTensor(){if(this.ensureValid(),!this.mlTensorData)throw new Error("The data is not stored as a WebNN MLTensor.");return this.mlTensorData}async getData(e){switch(this.ensureValid(),this.dataLocation){case"cpu":case"cpu-pinned":return this.data;case"texture":case"gpu-buffer":case"ml-tensor":{if(!this.downloader)throw new Error("The current tensor is not created with a specified data downloader.");if(this.isDownloading)throw new Error("The current tensor is being downloaded.");try{this.isDownloading=!0;let t=await this.downloader();return this.downloader=void 0,this.dataLocation="cpu",this.cpuData=t,e&&this.disposer&&(this.disposer(),this.disposer=void 0),t}finally{this.isDownloading=!1}}default:throw new Error(`cannot get data from location: ${this.dataLocation}`)}}dispose(){if(this.isDownloading)throw new Error("The current tensor is being downloaded.");this.disposer&&(this.disposer(),this.disposer=void 0),this.cpuData=void 0,this.gpuTextureData=void 0,this.gpuBufferData=void 0,this.mlTensorData=void 0,this.downloader=void 0,this.isDownloading=void 0,this.dataLocation="none"}ensureValid(){if(this.dataLocation==="none")throw new Error("The tensor is disposed.")}reshape(e){if(this.ensureValid(),this.downloader||this.disposer)throw new Error("Cannot reshape a tensor that owns GPU resource.");return jd(this,e)}}}),tt,Kd=U(()=>{Aa(),tt=Ue}),Lr,$i,rt,Xe,Ct,At,Zd=U(()=>{Dd(),Lr=(e,t)=>{(typeof Ie.trace>"u"?!Ie.wasm.trace:!Ie.trace)||console.timeStamp(`${e}::ORT::${t}`)},$i=(e,t)=>{var a;let r=((a=new Error().stack)==null?void 0:a.split(/\r\n|\r|\n/g))||[],i=!1;for(let s=0;s<r.length;s++){if(i&&!r[s].includes("TRACE_FUNC")){let n=`FUNC_${e}::${r[s].trim().split(" ")[1]}`;t&&(n+=`::${t}`),Lr("CPU",n);return}r[s].includes("TRACE_FUNC")&&(i=!0)}},rt=e=>{(typeof Ie.trace>"u"?!Ie.wasm.trace:!Ie.trace)||$i("BEGIN",e)},Xe=e=>{(typeof Ie.trace>"u"?!Ie.wasm.trace:!Ie.trace)||$i("END",e)},Ct=e=>{(typeof Ie.trace>"u"?!Ie.wasm.trace:!Ie.trace)||console.time(`ORT::${e}`)},At=e=>{(typeof Ie.trace>"u"?!Ie.wasm.trace:!Ie.trace)||console.timeEnd(`ORT::${e}`)}}),Xd,Lg=U(()=>{Nd(),Kd(),Zd(),Xd=class Qd{constructor(t){this.handler=t}async run(t,r,i){rt(),Ct("InferenceSession.run");let a={},s={};if(typeof t!="object"||t===null||t instanceof tt||Array.isArray(t))throw new TypeError("'feeds' must be an object that use input names as keys and OnnxValue as corresponding values.");let n=!0;if(typeof r=="object"){if(r===null)throw new TypeError("Unexpected argument[1]: cannot be null.");if(r instanceof tt)throw new TypeError("'fetches' cannot be a Tensor");if(Array.isArray(r)){if(r.length===0)throw new TypeError("'fetches' cannot be an empty array.");n=!1;for(let p of r){if(typeof p!="string")throw new TypeError("'fetches' must be a string array or an object.");if(this.outputNames.indexOf(p)===-1)throw new RangeError(`'fetches' contains invalid output name: ${p}.`);a[p]=null}if(typeof i=="object"&&i!==null)s=i;else if(typeof i<"u")throw new TypeError("'options' must be an object.")}else{let p=!1,h=Object.getOwnPropertyNames(r);for(let m of this.outputNames)if(h.indexOf(m)!==-1){let g=r[m];(g===null||g instanceof tt)&&(p=!0,n=!1,a[m]=g)}if(p){if(typeof i=="object"&&i!==null)s=i;else if(typeof i<"u")throw new TypeError("'options' must be an object.")}else s=r}}else if(typeof r<"u")throw new TypeError("Unexpected argument[1]: must be 'fetches' or 'options'.");for(let p of this.inputNames)if(typeof t[p]>"u")throw new Error(`input '${p}' is missing in 'feeds'.`);if(n)for(let p of this.outputNames)a[p]=null;let u=await this.handler.run(t,a,s),l={};for(let p in u)if(Object.hasOwnProperty.call(u,p)){let h=u[p];h instanceof tt?l[p]=h:l[p]=new tt(h.type,h.data,h.dims)}return At("InferenceSession.run"),Xe(),l}async release(){return this.handler.dispose()}static async create(t,r,i,a){rt(),Ct("InferenceSession.create");let s,n={};if(typeof t=="string"){if(s=t,typeof r=="object"&&r!==null)n=r;else if(typeof r<"u")throw new TypeError("'options' must be an object.")}else if(t instanceof Uint8Array){if(s=t,typeof r=="object"&&r!==null)n=r;else if(typeof r<"u")throw new TypeError("'options' must be an object.")}else if(t instanceof ArrayBuffer||typeof SharedArrayBuffer<"u"&&t instanceof SharedArrayBuffer){let h=t,m=0,g=t.byteLength;if(typeof r=="object"&&r!==null)n=r;else if(typeof r=="number"){if(m=r,!Number.isSafeInteger(m))throw new RangeError("'byteOffset' must be an integer.");if(m<0||m>=h.byteLength)throw new RangeError(`'byteOffset' is out of range [0, ${h.byteLength}).`);if(g=t.byteLength-m,typeof i=="number"){if(g=i,!Number.isSafeInteger(g))throw new RangeError("'byteLength' must be an integer.");if(g<=0||m+g>h.byteLength)throw new RangeError(`'byteLength' is out of range (0, ${h.byteLength-m}].`);if(typeof a=="object"&&a!==null)n=a;else if(typeof a<"u")throw new TypeError("'options' must be an object.")}else if(typeof i<"u")throw new TypeError("'byteLength' must be a number.")}else if(typeof r<"u")throw new TypeError("'options' must be an object.");s=new Uint8Array(h,m,g)}else throw new TypeError("Unexpected argument[0]: must be 'path' or 'buffer'.");let[u,l]=await Bd(n),p=await u.createInferenceSessionHandler(s,l);return At("InferenceSession.create"),Xe(),new Qd(p)}startProfiling(){this.handler.startProfiling()}endProfiling(){this.handler.endProfiling()}get inputNames(){return this.handler.inputNames}get outputNames(){return this.handler.outputNames}get inputMetadata(){return this.handler.inputMetadata}get outputMetadata(){return this.handler.outputMetadata}}}),Yd,Wg=U(()=>{Lg(),Yd=Xd}),Vg=U(()=>{}),Gg=U(()=>{}),Hg=U(()=>{}),Fg=U(()=>{}),Jd={};Gt(Jd,{InferenceSession:()=>Yd,TRACE:()=>Lr,TRACE_EVENT_BEGIN:()=>Ct,TRACE_EVENT_END:()=>At,TRACE_FUNC_BEGIN:()=>rt,TRACE_FUNC_END:()=>Xe,Tensor:()=>tt,env:()=>we,registerBackend:()=>qt});var We=U(()=>{Bg(),Mg(),Wg(),Kd(),Vg(),Gg(),Zd(),Hg(),Fg()}),Oa=U(()=>{}),ep={};Gt(ep,{default:()=>tp});var wi,vi,tp,jg=U(()=>{var e;of(),Nt(),Ra(),wi="ort-wasm-proxy-worker",vi=((e=globalThis.self)==null?void 0:e.name)===wi,vi&&(self.onmessage=t=>{let{type:r,in:i}=t.data;try{switch(r){case"init-wasm":Ba(i.wasm).then(()=>{Qa(i).then(()=>{postMessage({type:r})},a=>{postMessage({type:r,err:a})})},a=>{postMessage({type:r,err:a})});break;case"init-ep":{let{epName:a,env:s}=i;Ya(s,a).then(()=>{postMessage({type:r})},n=>{postMessage({type:r,err:n})});break}case"copy-from":{let{buffer:a}=i,s=Kr(a);postMessage({type:r,out:s});break}case"create":{let{model:a,options:s}=i;Ja(a,s).then(n=>{postMessage({type:r,out:n})},n=>{postMessage({type:r,err:n})});break}case"release":en(i),postMessage({type:r});break;case"run":{let{sessionId:a,inputIndices:s,inputs:n,outputIndices:u,options:l}=i;tn(a,s,n,u,new Array(u.length).fill(null),l).then(p=>{p.some(h=>h[3]!=="cpu")?postMessage({type:r,err:"Proxy does not support non-cpu tensor location."}):postMessage({type:r,out:p},an([...n,...p]))},p=>{postMessage({type:r,err:p})});break}case"end-profiling":rn(i),postMessage({type:r});break;default:}}catch(a){postMessage({type:r,err:a})}}),tp=vi?null:t=>new Worker(t!=null?t:De,{type:"module",name:wi})}),rp={};Gt(rp,{default:()=>ip});async function to(e={}){var Xs,Qs,Ys;var t=e,r=!!globalThis.window,i=!!globalThis.WorkerGlobalScope,a=i&&((Xs=self.name)==null?void 0:Xs.startsWith("em-pthread"));t.mountExternalData=(o,d)=>{o.startsWith("./")&&(o=o.substring(2)),(t.Xc||(t.Xc=new Map)).set(o,d)},t.unmountExternalData=()=>{delete t.Xc},(Qs=globalThis.SharedArrayBuffer)!=null||new WebAssembly.Memory({initial:0,maximum:0,shared:!0}).buffer.constructor;let s=o=>async(...d)=>{var f;try{if(t.Yc)throw Error("Session already started");let c=t.Yc={Kd:d[0],errors:[]},$=await o(...d);if(t.Yc!==c)throw Error("Session mismatch");(f=t.dd)==null||f.flush();let T=c.errors;if(0<T.length){let z=await Promise.all(T);if(z=z.filter(B=>B),0<z.length)throw Error(z.join(`
`))}return $}finally{t.Yc=null}};t.jsepInit=(o,d)=>{if(o==="webgpu"){[t.dd,t.Ad,t.Ed,t.ed,t.Dd,t.$b,t.Fd,t.Hd,t.Bd,t.Cd,t.Gd]=d;let f=t.dd;t.jsepRegisterBuffer=(c,$,T,z)=>f.registerBuffer(c,$,T,z),t.jsepGetBuffer=c=>f.getBuffer(c),t.jsepCreateDownloader=(c,$,T)=>f.createDownloader(c,$,T),t.jsepOnCreateSession=c=>{f.onCreateSession(c)},t.jsepOnReleaseSession=c=>{f.onReleaseSession(c)},t.jsepOnRunStart=c=>f.onRunStart(c),t.Id=(c,$)=>{f.upload(c,$)}}else if(o==="webnn"){let f=d[0];[t.Sd,t.sd,t.webnnEnsureTensor,t.td,t.webnnDownloadTensor,t.Rd,t.webnnEnableTraceEvent]=d.slice(1),t.webnnReleaseTensorId=t.sd,t.webnnUploadTensor=t.td,t.webnnRegisterMLContext=t.Rd,t.webnnOnRunStart=c=>f.onRunStart(c),t.webnnOnRunEnd=f.onRunEnd.bind(f),t.webnnOnReleaseSession=c=>{f.onReleaseSession(c)},t.webnnCreateMLTensorDownloader=(c,$)=>f.createMLTensorDownloader(c,$),t.webnnRegisterMLTensor=(c,$,T,z)=>f.registerMLTensor(c,$,T,z),t.webnnCreateMLContext=c=>f.createMLContext(c),t.webnnRegisterMLConstant=(c,$,T,z,B,W)=>f.registerMLConstant(c,$,T,z,B,t.Xc,W),t.webnnRegisterGraphInput=f.registerGraphInput.bind(f),t.webnnIsGraphInput=f.isGraphInput.bind(f),t.webnnRegisterGraphOutput=f.registerGraphOutput.bind(f),t.webnnIsGraphOutput=f.isGraphOutput.bind(f),t.webnnCreateTemporaryTensor=f.createTemporaryTensor.bind(f),t.webnnIsGraphInputOutputTypeSupported=f.isGraphInputOutputTypeSupported.bind(f)}};let n=()=>{let o=d=>(...f)=>{let c=Ye;return f=d(...f),Ye!=c?new Promise(($,T)=>{ni={resolve:$,reject:T}}):f};(()=>{for(let d of["_OrtAppendExecutionProvider","_OrtCreateSession","_OrtRun","_OrtRunWithBinding","_OrtBindInput"])t[d]=o(t[d])})(),s!==void 0&&(t._OrtRun=s(t._OrtRun),t._OrtRunWithBinding=s(t._OrtRunWithBinding)),n=void 0};t.asyncInit=()=>{n==null||n()};var u,l,p=(o,d)=>{throw d},h=import.meta.url,m="";if(r||i){try{m=new URL(".",h).href}catch(o){}i&&(l=o=>{var d=new XMLHttpRequest;return d.open("GET",o,!1),d.responseType="arraybuffer",d.send(null),new Uint8Array(d.response)}),u=async o=>{if(C(o))return new Promise((f,c)=>{var $=new XMLHttpRequest;$.open("GET",o,!0),$.responseType="arraybuffer",$.onload=()=>{$.status==200||$.status==0&&$.response?f($.response):c($.status)},$.onerror=c,$.send(null)});var d=await fetch(o,{credentials:"same-origin"});if(d.ok)return d.arrayBuffer();throw Error(d.status+" : "+d.url)}}var g,y,_,b,S,v,w=console.log.bind(console),I=console.error.bind(console),k=w,E=I,A=!1,C=o=>o.startsWith("file://");function x(){dt.buffer!=M.buffer&&H()}if(a){let o=function(d){try{var f=d.data,c=f.Sc;if(c==="load"){let $=[];self.onmessage=T=>$.push(T),v=()=>{postMessage({Sc:"loaded"});for(let T of $)o(T);self.onmessage=o};for(let T of f.xd)t[T]&&!t[T].proxy||(t[T]=(...z)=>{postMessage({Sc:"callHandler",wd:T,args:z})},T=="print"&&(k=t[T]),T=="printErr"&&(E=t[T]));dt=f.Od,H(),y=f.Pd,qe(),kr()}else if(c==="run"){(function($){var T=(x(),G)[$+52>>>2>>>0];$=(x(),G)[$+56>>>2>>>0],ss(T,T-$),oe(T)})(f.Rc),di(f.Rc,0,0,1,0,0),on(),ri(f.Rc),D||(es(),D=!0);try{bf(f.Md,f.bd)}catch($){if($!="unwind")throw $}}else f.target!=="setimmediate"&&(c==="checkMailbox"?D&&_r():c&&(E(`worker: received unknown command ${c}`),E(f)))}catch($){throw ts(),$}};var D=!1;self.onunhandledrejection=d=>{throw d.reason||d},self.onmessage=o}var M,P,K,Z,O,G,F,Y,he,V,se,q=!1;function H(){var o=dt.buffer;t.HEAP8=M=new Int8Array(o),K=new Int16Array(o),t.HEAPU8=P=new Uint8Array(o),Z=new Uint16Array(o),t.HEAP32=O=new Int32Array(o),t.HEAPU32=G=new Uint32Array(o),F=new Float32Array(o),Y=new Float64Array(o),he=new BigInt64Array(o),V=new BigUint64Array(o)}function X(){q=!0,a?v():at.sb()}function L(o){throw E(o="Aborted("+o+")"),A=!0,o=new WebAssembly.RuntimeError(o+". Build with -sASSERTIONS for more info."),S==null||S(o),o}function me(){return{a:{ma:Wm,gb:Lm,g:$f,J:wf,f:vf,o:xf,h:Sf,ha:kf,b:Tf,T:If,Ha:hn,n:Ef,$:yn,Xa:_n,Da:bn,Fa:$n,Ya:wn,Va:vn,Oa:xn,Ua:Sn,ka:kn,Ea:Tn,Ba:In,Wa:En,Ca:zn,bb:zf,ea:Cf,wa:Af,ua:Rf,da:Nf,O:Mf,H:Df,va:Uf,_:Hf,xa:Ff,Ra:jf,za:Zf,Ia:Xf,sa:Qf,fa:Yf,Qa:ri,_a:Jf,R:im,r:um,c:ei,hb:lm,y:dm,M:pm,D:cm,l:hm,s:Dn,ib:fm,I:mm,S:gm,j:ym,u:_m,q:bm,k:$m,La:wm,Ma:vm,Na:xm,Ja:Ln,Ka:Wn,ta:Vn,db:km,ab:Im,v:Em,aa:zm,ga:Cm,$a:Tm,W:Am,Za:Om,Aa:Rm,F:Sm,U:Bm,la:xr,ya:Mm,fb:Nm,eb:Dm,Sa:jn,Ta:Kn,Ga:Ht,V:Zn,ja:Xn,Pa:Qn,ia:Yn,kb:Sg,na:bg,lb:xg,oa:_g,G:lg,e:Fm,t:Gm,w:Vm,B:rg,mb:mg,K:sg,x:Zm,pa:gg,Y:$g,ba:fg,nb:hg,ob:cg,P:ig,qa:pg,pb:dg,N:og,Z:yg,d:Hm,A:Km,m:jm,jb:kg,p:Qm,z:Ym,C:Xm,E:Jm,L:ag,qb:ug,Q:wg,ca:ng,X:vg,rb:tg,ra:eg,i:Pm,a:dt,cb:Me}}}async function qe(){function o(c,$){var T=at=c.exports;c={};for(let[z,B]of Object.entries(T))typeof B=="function"?(T=em(B),c[z]=T):c[z]=B;return at=c,at=(function(){var z=at,B=j=>ne=>j(ne)>>>0,W=j=>()=>j()>>>0;return(z=Object.assign({},z)).tb=B(z.tb),z.Xb=W(z.Xb),z.Zb=B(z.Zb),z.lc=B(z.lc),z.mc=W(z.mc),z.qc=B(z.qc),z})(),nn.push(at._b),Jn=(c=at).tb,es=c.ub,t._OrtInit=c.vb,t._OrtGetLastError=c.wb,t._OrtCreateSessionOptions=c.xb,t._OrtAppendExecutionProvider=c.yb,t._OrtAddFreeDimensionOverride=c.zb,t._OrtAddSessionConfigEntry=c.Ab,t._OrtReleaseSessionOptions=c.Bb,t._OrtCreateSession=c.Cb,t._OrtReleaseSession=c.Db,t._OrtGetInputOutputCount=c.Eb,t._OrtGetInputOutputMetadata=c.Fb,t._OrtFree=c.Gb,t._OrtCreateTensor=c.Hb,t._OrtGetTensorData=c.Ib,t._OrtReleaseTensor=c.Jb,t._OrtCreateRunOptions=c.Kb,t._OrtAddRunConfigEntry=c.Lb,t._OrtReleaseRunOptions=c.Mb,t._OrtCreateBinding=c.Nb,t._OrtBindInput=c.Ob,t._OrtBindOutput=c.Pb,t._OrtClearBoundOutputs=c.Qb,t._OrtReleaseBinding=c.Rb,t._OrtRunWithBinding=c.Sb,t._OrtRun=c.Tb,t._OrtEndProfiling=c.Ub,t._JsepOutput=c.Vb,t._JsepGetNodeName=c.Wb,Sr=c.Xb,Je=t._free=c.Yb,Kt=t._malloc=c.Zb,di=c.ac,ts=c.bc,rs=c.cc,is=c.dc,pi=c.ec,as=c.fc,ns=c.gc,le=c.hc,Zt=c.ic,ss=c.jc,oe=c.kc,ci=c.lc,ue=c.mc,os=c.nc,hi=c.oc,us=c.pc,ls=c.qc,ds=c.rc,fi=c.sc,ps=c.tc,cs=c.uc,hs=c.vc,fs=c.wc,ms=c.xc,gs=c.yc,ys=c.zc,_s=c.Ac,bs=c.Bc,$s=c.Cc,ws=c.Dc,vs=c.Ec,xs=c.Fc,Ss=c.Gc,ks=c.Hc,Ts=c.Ic,Is=c.Jc,Es=c.Kc,zs=c.Lc,Cs=c.Mc,As=c.Nc,Os=c.Pc,Rs=c.Qc,Bs=c.$c,Ns=c.ad,Ms=c.fd,Ds=c.jd,Us=c.kd,Ps=c.ld,qs=c.md,Ls=c.nd,Ws=c.od,Vs=c.pd,Gs=c.qd,Hs=c.vd,Fs=c.Td,js=c.Ud,Ks=c.Vd,Zs=c.Wd,y=$,at}var d,f=me();return t.instantiateWasm?new Promise(c=>{t.instantiateWasm(f,($,T)=>{c(o($,T))})}):a?o(new WebAssembly.Instance(y,me()),y):(se!=null||(se=t.locateFile?t.locateFile?t.locateFile("ort-wasm-simd-threaded.jsep.wasm",m):m+"ort-wasm-simd-threaded.jsep.wasm":new URL(""+new URL("ort-wasm-simd-threaded.jsep-DC5y_g6C.wasm",import.meta.url).href,import.meta.url).href),d=await(async function(c){var $=se;if(!g&&!C($))try{var T=fetch($,{credentials:"same-origin"});return await WebAssembly.instantiateStreaming(T,c)}catch(z){E(`wasm streaming compile failed: ${z}`),E("falling back to ArrayBuffer instantiation")}return(async function(z,B){try{var W=await(async function(j){if(!g)try{var ne=await u(j);return new Uint8Array(ne)}catch(pe){}if(j==se&&g)j=new Uint8Array(g);else{if(!l)throw"both async and sync fetching of the wasm failed";j=l(j)}return j})(z);return await WebAssembly.instantiate(W,B)}catch(j){E(`failed to asynchronously prepare wasm: ${j}`),L(j)}})($,c)})(f),o(d.instance,d.module))}class Se{constructor(d){Js(this,"name","ExitStatus");this.message=`Program terminated with exit(${d})`,this.status=d}}var Ae=o=>{o.terminate(),o.onmessage=()=>{}},Oe=[],Ne=0,Re=null,ut=o=>{lt.length==0&&(ln(),un(lt[0]));var d=lt.pop();if(!d)return 6;Ft.push(d),bt[o.Rc]=d,d.Rc=o.Rc;var f={Sc:"run",Md:o.Ld,bd:o.bd,Rc:o.Rc};return d.postMessage(f,o.rd),0},be=0,re=(o,d,...f)=>{var c,$=16*f.length,T=ue(),z=ci($),B=z>>>3;for(c of f)typeof c=="bigint"?((x(),he)[B++>>>0]=BigInt(1),(x(),he)[B++>>>0]=c):((x(),he)[B++>>>0]=BigInt(0),(x(),Y)[B++>>>0]=c);return o=rs(o,0,$,z,d),oe(T),o};function Me(o){if(a)return re(0,1,o);if(_=o,!(0<be)){for(var d of Ft)Ae(d);for(d of lt)Ae(d);lt=[],Ft=[],bt={},A=!0}p(0,new Se(o))}function hr(o){if(a)return re(1,0,o);Ht(o)}var Ht=o=>{if(_=o,a)throw hr(o),"unwind";Me(o)},lt=[],Ft=[],nn=[],bt={},sn=o=>{var d=o.Rc;delete bt[d],lt.push(o),Ft.splice(Ft.indexOf(o),1),o.Rc=0,is(d)};function on(){nn.forEach(o=>o())}var un=o=>new Promise(d=>{o.onmessage=$=>{var T=$.data;if($=T.Sc,T.Zc&&T.Zc!=Sr()){var z=bt[T.Zc];z?z.postMessage(T,T.rd):E(`Internal error! Worker sent a message "${$}" to target pthread ${T.Zc}, but that thread no longer exists!`)}else $==="checkMailbox"?_r():$==="spawnThread"?ut(T):$==="cleanupThread"?yr(()=>{sn(bt[T.Nd])}):$==="loaded"?(o.loaded=!0,d(o)):T.target==="setimmediate"?o.postMessage(T):$==="uncaughtException"?o.onerror(T.error):$==="callHandler"?t[T.wd](...T.args):$&&E(`worker sent an unknown command ${$}`)},o.onerror=$=>{throw E(`worker sent an error! ${$.filename}:${$.lineno}: ${$.message}`),$};var f,c=[];for(f of[])t.propertyIsEnumerable(f)&&c.push(f);o.postMessage({Sc:"load",xd:c,Od:dt,Pd:y})});function ln(){var o=new Worker((()=>{let d=URL;return import.meta.url>"file:"&&import.meta.url<"file;"?new d("ort.bundle.min.mjs",import.meta.url):new URL(import.meta.url)})(),{type:"module",workerData:"em-pthread",name:"em-pthread"});lt.push(o)}var dt,bf=(o,d)=>{be=0,o=fi(o,d),0<be?_=o:pi(o)},fr=[],mr=0;function $f(o){var d=new Xr(o>>>=0);return(x(),M)[d.Tc+12>>>0]==0&&(dn(d,!0),mr--),pn(d,!1),fr.push(d),ls(o)}var Dt=0,wf=()=>{le(0,0);var o=fr.pop();os(o.cd),Dt=0};function dn(o,d){d=d?1:0,(x(),M)[o.Tc+12>>>0]=d}function pn(o,d){d=d?1:0,(x(),M)[o.Tc+13>>>0]=d}class Xr{constructor(d){this.cd=d,this.Tc=d-24}}var Qr=o=>{var d=Dt;if(!d)return Zt(0),0;var f=new Xr(d);(x(),G)[f.Tc+16>>>2>>>0]=d;var c=(x(),G)[f.Tc+4>>>2>>>0];if(!c)return Zt(0),d;for(var $ of o){if($===0||$===c)break;if(us($,c,f.Tc+16))return Zt($),d}return Zt(c),d};function vf(){return Qr([])}function xf(o){return Qr([o>>>0])}function Sf(o,d,f,c){return Qr([o>>>0,d>>>0,f>>>0,c>>>0])}var kf=()=>{var o=fr.pop();o||L("no exception to throw");var d=o.cd;throw(x(),M)[o.Tc+13>>>0]==0&&(fr.push(o),pn(o,!0),dn(o,!1),mr++),hi(d),Dt=d};function Tf(o,d,f){var c=new Xr(o>>>=0);throw d>>>=0,f>>>=0,(x(),G)[c.Tc+16>>>2>>>0]=0,(x(),G)[c.Tc+4>>>2>>>0]=d,(x(),G)[c.Tc+8>>>2>>>0]=f,hi(o),mr++,Dt=o}var If=()=>mr;function cn(o,d,f,c){return a?re(2,1,o,d,f,c):hn(o,d,f,c)}function hn(o,d,f,c){if(o>>>=0,d>>>=0,f>>>=0,c>>>=0,!globalThis.SharedArrayBuffer)return 6;var $=[];return a&&$.length===0?cn(o,d,f,c):(o={Ld:f,Rc:o,bd:c,rd:$},a?(o.Sc="spawnThread",postMessage(o,$),0):ut(o))}function Ef(o){throw Dt||(Dt=o>>>0),Dt}var fn=globalThis.TextDecoder&&new TextDecoder,mn=(o,d,f,c)=>{if(f=d+f,c)return f;for(;o[d]&&!(d>=f);)++d;return d},gn=(o,d=0,f,c)=>{if(16<(f=mn(o,d>>>=0,f,c))-d&&o.buffer&&fn)return fn.decode(o.buffer instanceof ArrayBuffer?o.subarray(d,f):o.slice(d,f));for(c="";d<f;){var $=o[d++];if(128&$){var T=63&o[d++];if((224&$)==192)c+=String.fromCharCode((31&$)<<6|T);else{var z=63&o[d++];65536>($=(240&$)==224?(15&$)<<12|T<<6|z:(7&$)<<18|T<<12|z<<6|63&o[d++])?c+=String.fromCharCode($):($-=65536,c+=String.fromCharCode(55296|$>>10,56320|1023&$))}}else c+=String.fromCharCode($)}return c},ke=(o,d,f)=>(o>>>=0)?gn((x(),P),o,d,f):"";function yn(o,d,f){return a?re(3,1,o,d,f):0}function _n(o,d){if(a)return re(4,1,o,d)}function bn(o,d){if(a)return re(5,1,o,d)}function $n(o,d,f){if(a)return re(6,1,o,d,f)}function wn(o,d,f){return a?re(7,1,o,d,f):0}function vn(o,d){if(a)return re(8,1,o,d)}function xn(o,d,f){if(a)return re(9,1,o,d,f)}function Sn(o,d,f,c){if(a)return re(10,1,o,d,f,c)}function kn(o,d,f,c){if(a)return re(11,1,o,d,f,c)}function Tn(o,d,f,c){if(a)return re(12,1,o,d,f,c)}function In(o){if(a)return re(13,1,o)}function En(o,d){if(a)return re(14,1,o,d)}function zn(o,d,f){if(a)return re(15,1,o,d,f)}var zf=()=>L(""),Qe=o=>{o>>>=0;for(var d="";;){var f=(x(),P)[o++>>>0];if(!f)return d;d+=String.fromCharCode(f)}},Yr={},Jr={},Ut=class extends Error{constructor(o){super(o),this.name="BindingError"}};function it(o,d,f={}){return(function(c,$,T={}){var z=$.name;if(!c)throw new Ut(`type "${z}" must have a positive integer typeid pointer`);if(Jr.hasOwnProperty(c)){if(T.yd)return;throw new Ut(`Cannot register type '${z}' twice`)}Jr[c]=$,Yr.hasOwnProperty(c)&&($=Yr[c],delete Yr[c],$.forEach(B=>B()))})(o,d,f)}var Cn=(o,d,f)=>{switch(d){case 1:return f?c=>(x(),M)[c>>>0]:c=>(x(),P)[c>>>0];case 2:return f?c=>(x(),K)[c>>>1>>>0]:c=>(x(),Z)[c>>>1>>>0];case 4:return f?c=>(x(),O)[c>>>2>>>0]:c=>(x(),G)[c>>>2>>>0];case 8:return f?c=>(x(),he)[c>>>3>>>0]:c=>(x(),V)[c>>>3>>>0];default:throw new TypeError(`invalid integer width (${d}): ${o}`)}};function Cf(o,d,f,c,$){o>>>=0,f>>>=0,d=Qe(d>>>0);let T=z=>z;if(c=c===BigInt(0)){let z=8*f;T=B=>BigInt.asUintN(z,B),$=T($)}it(o,{name:d,Oc:T,Vc:(z,B)=>(typeof B=="number"&&(B=BigInt(B)),B),Uc:Cn(d,f,!c),Wc:null})}function Af(o,d,f,c){it(o>>>=0,{name:d=Qe(d>>>0),Oc:function($){return!!$},Vc:function($,T){return T?f:c},Uc:function($){return this.Oc((x(),P)[$>>>0])},Wc:null})}var An=[],$t=[0,1,,1,null,1,!0,1,!1,1];function ei(o){9<(o>>>=0)&&--$t[o+1]===0&&($t[o]=void 0,An.push(o))}var Le=o=>{if(!o)throw new Ut(`Cannot use deleted val. handle = ${o}`);return $t[o]},Ve=o=>{switch(o){case void 0:return 2;case null:return 4;case!0:return 6;case!1:return 8;default:let d=An.pop()||$t.length;return $t[d]=o,$t[d+1]=1,d}};function ti(o){return this.Oc((x(),G)[o>>>2>>>0])}var Of={name:"emscripten::val",Oc:o=>{var d=Le(o);return ei(o),d},Vc:(o,d)=>Ve(d),Uc:ti,Wc:null};function Rf(o){return it(o>>>0,Of)}var Bf=(o,d)=>{switch(d){case 4:return function(f){return this.Oc((x(),F)[f>>>2>>>0])};case 8:return function(f){return this.Oc((x(),Y)[f>>>3>>>0])};default:throw new TypeError(`invalid float width (${d}): ${o}`)}};function Nf(o,d,f){f>>>=0,it(o>>>=0,{name:d=Qe(d>>>0),Oc:c=>c,Vc:(c,$)=>$,Uc:Bf(d,f),Wc:null})}function Mf(o,d,f,c,$){o>>>=0,f>>>=0,d=Qe(d>>>0);let T=B=>B;if(c===0){var z=32-8*f;T=B=>B<<z>>>z,$=T($)}it(o,{name:d,Oc:T,Vc:(B,W)=>W,Uc:Cn(d,f,c!==0),Wc:null})}function Df(o,d,f){function c(T){var z=(x(),G)[T>>>2>>>0];return T=(x(),G)[T+4>>>2>>>0],new $((x(),M).buffer,T,z)}var $=[Int8Array,Uint8Array,Int16Array,Uint16Array,Int32Array,Uint32Array,Float32Array,Float64Array,BigInt64Array,BigUint64Array][d];it(o>>>=0,{name:f=Qe(f>>>0),Oc:c,Uc:c},{yd:!0})}var pt=(o,d,f)=>{var c=(x(),P);if(d>>>=0,0<f){var $=d;f=d+f-1;for(var T=0;T<o.length;++T){var z=o.codePointAt(T);if(127>=z){if(d>=f)break;c[d++>>>0]=z}else if(2047>=z){if(d+1>=f)break;c[d++>>>0]=192|z>>6,c[d++>>>0]=128|63&z}else if(65535>=z){if(d+2>=f)break;c[d++>>>0]=224|z>>12,c[d++>>>0]=128|z>>6&63,c[d++>>>0]=128|63&z}else{if(d+3>=f)break;c[d++>>>0]=240|z>>18,c[d++>>>0]=128|z>>12&63,c[d++>>>0]=128|z>>6&63,c[d++>>>0]=128|63&z,T++}}c[d>>>0]=0,o=d-$}else o=0;return o},gr=o=>{for(var d=0,f=0;f<o.length;++f){var c=o.charCodeAt(f);127>=c?d++:2047>=c?d+=2:55296<=c&&57343>=c?(d+=4,++f):d+=3}return d};function Uf(o,d){it(o>>>=0,{name:d=Qe(d>>>0),Oc(f){var c=(x(),G)[f>>>2>>>0];return c=ke(f+4,c,!0),Je(f),c},Vc(f,c){c instanceof ArrayBuffer&&(c=new Uint8Array(c));var $=typeof c=="string";if(!($||ArrayBuffer.isView(c)&&c.BYTES_PER_ELEMENT==1))throw new Ut("Cannot pass non-string to std::string");var T=$?gr(c):c.length,z=Kt(4+T+1),B=z+4;return(x(),G)[z>>>2>>>0]=T,$?pt(c,B,T+1):(x(),P).set(c,B>>>0),f!==null&&f.push(Je,z),z},Uc:ti,Wc(f){Je(f)}})}var On=globalThis.TextDecoder?new TextDecoder("utf-16le"):void 0,Pf=(o,d,f)=>{if(o>>>=1,16<(d=mn((x(),Z),o,d/2,f))-o&&On)return On.decode((x(),Z).slice(o,d));for(f="";o<d;++o){var c=(x(),Z)[o>>>0];f+=String.fromCharCode(c)}return f},qf=(o,d,f)=>{if(f!=null||(f=2147483647),2>f)return 0;var c=d;f=(f-=2)<2*o.length?f/2:o.length;for(var $=0;$<f;++$){var T=o.charCodeAt($);(x(),K)[d>>>1>>>0]=T,d+=2}return(x(),K)[d>>>1>>>0]=0,d-c},Lf=o=>2*o.length,Wf=(o,d,f)=>{var c="";o>>>=2;for(var $=0;!($>=d/4);$++){var T=(x(),G)[o+$>>>0];if(!T&&!f)break;c+=String.fromCodePoint(T)}return c},Vf=(o,d,f)=>{if(d>>>=0,f!=null||(f=2147483647),4>f)return 0;var c=d;f=c+f-4;for(var $=0;$<o.length;++$){var T=o.codePointAt($);if(65535<T&&$++,(x(),O)[d>>>2>>>0]=T,(d+=4)+4>f)break}return(x(),O)[d>>>2>>>0]=0,d-c},Gf=o=>{for(var d=0,f=0;f<o.length;++f)65535<o.codePointAt(f)&&f++,d+=4;return d};function Hf(o,d,f){if(o>>>=0,d>>>=0,f=Qe(f>>>=0),d===2)var c=Pf,$=qf,T=Lf;else c=Wf,$=Vf,T=Gf;it(o,{name:f,Oc:z=>{var B=(x(),G)[z>>>2>>>0];return B=c(z+4,B*d,!0),Je(z),B},Vc:(z,B)=>{if(typeof B!="string")throw new Ut(`Cannot pass non-string to C++ string type ${f}`);var W=T(B),j=Kt(4+W+d);return(x(),G)[j>>>2>>>0]=W/d,$(B,j+4,W+d),z!==null&&z.push(Je,j),j},Uc:ti,Wc(z){Je(z)}})}function Ff(o,d){it(o>>>=0,{zd:!0,name:d=Qe(d>>>0),Oc:()=>{},Vc:()=>{}})}function jf(o){di(o>>>0,!i,1,!r,131072,!1),on()}var yr=o=>{if(!A)try{if(o(),!(0<be))try{a?Sr()&&pi(_):Ht(_)}catch(d){d instanceof Se||d=="unwind"||p(0,d)}}catch(d){d instanceof Se||d=="unwind"||p(0,d)}},Kf=!Atomics.waitAsync||((Ys=globalThis.navigator)==null?void 0:Ys.userAgent)&&91>Number((navigator.userAgent.match(/Chrom(e|ium)\/([0-9]+)\./)||[])[2]);function ri(o){o>>>=0,Kf||(Atomics.waitAsync((x(),O),o>>>2,o).value.then(_r),o+=128,Atomics.store((x(),O),o>>>2,1))}var _r=()=>yr(()=>{var o=Sr();o&&(ri(o),ns())});function Zf(o,d){(o>>>=0)==d>>>0?setTimeout(_r):a?postMessage({Zc:o,Sc:"checkMailbox"}):(o=bt[o])&&o.postMessage({Sc:"checkMailbox"})}var ii=[];function Xf(o,d,f,c,$){for(d>>>=0,$>>>=0,ii.length=0,f=$>>>3,c=$+c>>>3;f<c;){var T;T=(x(),he)[f++>>>0]?(x(),he)[f++>>>0]:(x(),Y)[f++>>>0],ii.push(T)}return(d?mi[d]:qm[o])(...ii)}var Qf=()=>{be=0};function Yf(o){o>>>=0,a?postMessage({Sc:"cleanupThread",Nd:o}):sn(bt[o])}function Jf(o){}var br=o=>{try{o()}catch(d){L(d)}};function em(o){var d=(...f)=>{$r.push(o);try{return o(...f)}finally{A||($r.pop(),Ye&&ct===1&&$r.length===0&&(ct=0,be+=1,br(js),typeof Fibers<"u"&&Fibers.Zd()))}};return Nn.set(o,d),d}var ct=0,Ye=null,Rn=0,$r=[],ai=new Map,Bn=new Map,Nn=new Map,tm=0,ni=null,rm=[],Mn=o=>(function(d){if(!A){if(ct===0){var f=!1,c=!1;d(($=0)=>{if(!A&&(Rn=$,f=!0,c)){ct=2,br(()=>Ks(Ye)),typeof MainLoop<"u"&&MainLoop.ud&&MainLoop.resume(),$=!1;try{var T=(function(){var W=(x(),O)[Ye+8>>>2>>>0];return W=Bn.get(W),W=Nn.get(W),--be,W()})()}catch(W){T=W,$=!0}var z=!1;if(!Ye){var B=ni;B&&(ni=null,($?B.reject:B.resolve)(T),z=!0)}if($&&!z)throw T}}),c=!0,f||(ct=1,Ye=(function(){var $=Kt(65548),T=$+12;if((x(),G)[$>>>2>>>0]=T,(x(),G)[$+4>>>2>>>0]=T+65536,T=$r[0],!ai.has(T)){var z=tm++;ai.set(T,z),Bn.set(z,T)}return T=ai.get(T),(x(),O)[$+8>>>2>>>0]=T,$})(),typeof MainLoop<"u"&&MainLoop.ud&&MainLoop.pause(),br(()=>Fs(Ye)))}else ct===2?(ct=0,br(Zs),Je(Ye),Ye=null,rm.forEach(yr)):L(`invalid state: ${ct}`);return Rn}})(d=>{o().then(d)});function im(o){return o>>>=0,Mn(async()=>{var d=await Le(o);return Ve(d)})}var si=[],am=o=>{var d=si.length;return si.push(o),d},nm=(o,d)=>{for(var f=Array(o),c=0;c<o;++c){var $=c,T=(x(),G)[d+4*c>>>2>>>0],z=Jr[T];if(z===void 0)throw o=`parameter ${c}`,T=Jn(T),d=Qe(T),Je(T),new Ut(`${o} has unknown type ${d}`);f[$]=z}return f},sm=(o,d,f)=>{var c=[];return o=o(c,f),c.length&&((x(),G)[d>>>2>>>0]=Ve(c)),o},om={},wr=o=>{var d=om[o];return d===void 0?Qe(o):d};function um(o,d,f){var[c,...$]=nm(o,d>>>0);d=c.Vc.bind(c);var T=$.map(W=>W.Uc.bind(W));o--;var z={toValue:Le};switch(o=T.map((W,j)=>{var ne=`argFromPtr${j}`;return z[ne]=W,`${ne}(args${j?"+"+8*j:""})`}),f){case 0:var B="toValue(handle)";break;case 2:B="new (toValue(handle))";break;case 3:B="";break;case 1:z.getStringOrSymbol=wr,B="toValue(handle)[getStringOrSymbol(methodName)]"}return B+=`(${o})`,c.zd||(z.toReturnWire=d,z.emval_returnValue=sm,B=`return emval_returnValue(toReturnWire, destructorsRef, ${B})`),B=`return function (handle, methodName, destructorsRef, args) {
  ${B}
  }`,f=new Function(Object.keys(z),B)(...Object.values(z)),B=`methodCaller<(${$.map(W=>W.name)}) => ${c.name}>`,am(Object.defineProperty(f,"name",{value:B}))}function lm(o,d){return d>>>=0,(o=Le(o>>>0))==Le(d)}function dm(o){return(o>>>=0)?(o=wr(o),Ve(globalThis[o])):Ve(globalThis)}function pm(o){return o=wr(o>>>0),Ve(t[o])}function cm(o,d){return d>>>=0,o=Le(o>>>0),d=Le(d),Ve(o[d])}function hm(o){9<(o>>>=0)&&($t[o+1]+=1)}function Dn(o,d,f,c,$){return si[o>>>0](d>>>0,f>>>0,c>>>0,$>>>0)}function fm(o,d,f,c,$){return Dn(o>>>0,d>>>0,f>>>0,c>>>0,$>>>0)}function mm(){return Ve([])}function gm(o){o=Le(o>>>0);for(var d=Array(o.length),f=0;f<o.length;f++)d[f]=o[f];return Ve(d)}function ym(o){return Ve(wr(o>>>0))}function _m(){return Ve({})}function bm(o){for(var d=Le(o>>>=0);d.length;){var f=d.pop();d.pop()(f)}ei(o)}function $m(o,d,f){d>>>=0,f>>>=0,o=Le(o>>>0),d=Le(d),f=Le(f),o[d]=f}function wm(o,d){o=-9007199254740992>o||9007199254740992<o?NaN:Number(o),d>>>=0,o=new Date(1e3*o),(x(),O)[d>>>2>>>0]=o.getUTCSeconds(),(x(),O)[d+4>>>2>>>0]=o.getUTCMinutes(),(x(),O)[d+8>>>2>>>0]=o.getUTCHours(),(x(),O)[d+12>>>2>>>0]=o.getUTCDate(),(x(),O)[d+16>>>2>>>0]=o.getUTCMonth(),(x(),O)[d+20>>>2>>>0]=o.getUTCFullYear()-1900,(x(),O)[d+24>>>2>>>0]=o.getUTCDay(),o=(o.getTime()-Date.UTC(o.getUTCFullYear(),0,1,0,0,0,0))/864e5|0,(x(),O)[d+28>>>2>>>0]=o}var Un=o=>o%4==0&&(o%100!=0||o%400==0),Pn=[0,31,60,91,121,152,182,213,244,274,305,335],qn=[0,31,59,90,120,151,181,212,243,273,304,334];function vm(o,d){o=-9007199254740992>o||9007199254740992<o?NaN:Number(o),d>>>=0,o=new Date(1e3*o),(x(),O)[d>>>2>>>0]=o.getSeconds(),(x(),O)[d+4>>>2>>>0]=o.getMinutes(),(x(),O)[d+8>>>2>>>0]=o.getHours(),(x(),O)[d+12>>>2>>>0]=o.getDate(),(x(),O)[d+16>>>2>>>0]=o.getMonth(),(x(),O)[d+20>>>2>>>0]=o.getFullYear()-1900,(x(),O)[d+24>>>2>>>0]=o.getDay();var f=(Un(o.getFullYear())?Pn:qn)[o.getMonth()]+o.getDate()-1|0;(x(),O)[d+28>>>2>>>0]=f,(x(),O)[d+36>>>2>>>0]=-60*o.getTimezoneOffset(),f=new Date(o.getFullYear(),6,1).getTimezoneOffset();var c=new Date(o.getFullYear(),0,1).getTimezoneOffset();o=0|(f!=c&&o.getTimezoneOffset()==Math.min(c,f)),(x(),O)[d+32>>>2>>>0]=o}function xm(o){o>>>=0;var d=new Date((x(),O)[o+20>>>2>>>0]+1900,(x(),O)[o+16>>>2>>>0],(x(),O)[o+12>>>2>>>0],(x(),O)[o+8>>>2>>>0],(x(),O)[o+4>>>2>>>0],(x(),O)[o>>>2>>>0],0),f=(x(),O)[o+32>>>2>>>0],c=d.getTimezoneOffset(),$=new Date(d.getFullYear(),6,1).getTimezoneOffset(),T=new Date(d.getFullYear(),0,1).getTimezoneOffset(),z=Math.min(T,$);return 0>f?(x(),O)[o+32>>>2>>>0]=+($!=T&&z==c):0<f!=(z==c)&&($=Math.max(T,$),d.setTime(d.getTime()+6e4*((0<f?z:$)-c))),(x(),O)[o+24>>>2>>>0]=d.getDay(),f=(Un(d.getFullYear())?Pn:qn)[d.getMonth()]+d.getDate()-1|0,(x(),O)[o+28>>>2>>>0]=f,(x(),O)[o>>>2>>>0]=d.getSeconds(),(x(),O)[o+4>>>2>>>0]=d.getMinutes(),(x(),O)[o+8>>>2>>>0]=d.getHours(),(x(),O)[o+12>>>2>>>0]=d.getDate(),(x(),O)[o+16>>>2>>>0]=d.getMonth(),(x(),O)[o+20>>>2>>>0]=d.getYear(),o=d.getTime(),BigInt(isNaN(o)?-1:o/1e3)}function Ln(o,d,f,c,$,T,z){return a?re(16,1,o,d,f,c,$,T,z):-52}function Wn(o,d,f,c,$,T){if(a)return re(17,1,o,d,f,c,$,T)}var jt={},Sm=()=>performance.timeOrigin+performance.now();function Vn(o,d){if(a)return re(18,1,o,d);if(jt[o]&&(clearTimeout(jt[o].id),delete jt[o]),!d)return 0;var f=setTimeout(()=>{delete jt[o],yr(()=>as(o,performance.timeOrigin+performance.now()))},d);return jt[o]={id:f,Yd:d},0}function km(o,d,f,c){o>>>=0,d>>>=0,f>>>=0,c>>>=0;var $=new Date().getFullYear(),T=new Date($,0,1).getTimezoneOffset();$=new Date($,6,1).getTimezoneOffset();var z=Math.max(T,$);(x(),G)[o>>>2>>>0]=60*z,(x(),O)[d>>>2>>>0]=+(T!=$),o=(d=B=>{var W=Math.abs(B);return`UTC${0<=B?"-":"+"}${String(Math.floor(W/60)).padStart(2,"0")}${String(W%60).padStart(2,"0")}`})(T),d=d($),$<T?(pt(o,f,17),pt(d,c,17)):(pt(o,c,17),pt(d,f,17))}var Tm=()=>Date.now();function Im(o,d,f){return f>>>=0,0<=o&&3>=o?(o===0?o=Date.now():o=performance.timeOrigin+performance.now(),o=Math.round(1e6*o),(x(),he)[f>>>3>>>0]=BigInt(o),0):28}var oi=[],Gn=(o,d)=>{oi.length=0;for(var f;f=(x(),P)[o++>>>0];){var c=f!=105;d+=(c&=f!=112)&&d%8?4:0,oi.push(f==112?(x(),G)[d>>>2>>>0]:f==106?(x(),he)[d>>>3>>>0]:f==105?(x(),O)[d>>>2>>>0]:(x(),Y)[d>>>3>>>0]),d+=c?8:4}return oi};function Em(o,d,f){return o>>>=0,d=Gn(d>>>0,f>>>0),mi[o](...d)}function zm(o,d,f){return o>>>=0,d=Gn(d>>>0,f>>>0),mi[o](...d)}var Cm=()=>{};function Am(o,d){return E(ke(o>>>0,d>>>0))}var Om=()=>{throw be+=1,"unwind"};function Rm(){return 4294901760}var Bm=()=>navigator.hardwareConcurrency,wt={},vr=o=>{var d;return(d=/\bwasm-function\[\d+\]:(0x[0-9a-f]+)/.exec(o))?+d[1]:(d=/:(\d+):\d+(?:\)|$)/.exec(o))?2147483648|+d[1]:0},Hn=o=>{for(var d of o)(o=vr(d))&&(wt[o]=d)};function Nm(){var o=Error().stack.toString().split(`
`);return o[0]=="Error"&&o.shift(),Hn(o),wt.gd=vr(o[3]),wt.Jd=o,wt.gd}function xr(o){var c;if(!(o=wt[o>>>0]))return 0;var d;if(d=/^\s+at .*\.wasm\.(.*) \(.*\)$/.exec(o))o=d[1];else if(d=/^\s+at (.*) \(.*\)$/.exec(o))o=d[1];else{if(!(d=/^(.+?)@/.exec(o)))return 0;o=d[1]}Je((c=xr.hd)!=null?c:0),d=gr(o)+1;var f=Kt(d);return f&&pt(o,f,d),xr.hd=f,xr.hd}function Mm(o){o>>>=0;var d=(x(),P).length;if(o<=d||4294901760<o)return!1;for(var f=1;4>=f;f*=2){var c=d*(1+.2/f);c=Math.min(c,o+100663296);e:{c=(Math.min(4294901760,65536*Math.ceil(Math.max(o,c)/65536))-dt.buffer.byteLength+65535)/65536|0;try{dt.grow(c),H();var $=1;break e}catch(T){}$=void 0}if($)return!0}return!1}function Dm(o,d,f){if(o>>>=0,d>>>=0,wt.gd==o)var c=wt.Jd;else(c=Error().stack.toString().split(`
`))[0]=="Error"&&c.shift(),Hn(c);for(var $=3;c[$]&&vr(c[$])!=o;)++$;for(o=0;o<f&&c[o+$];++o)(x(),O)[d+4*o>>>2>>>0]=vr(c[o+$]);return o}var ui,li={},Fn=()=>{var c,$;if(!ui){var o,d={USER:"web_user",LOGNAME:"web_user",PATH:"/",PWD:"/",HOME:"/home/web_user",LANG:(($=(c=globalThis.navigator)==null?void 0:c.language)!=null?$:"C").replace("-","_")+".UTF-8",_:"./this.program"};for(o in li)li[o]===void 0?delete d[o]:d[o]=li[o];var f=[];for(o in d)f.push(`${o}=${d[o]}`);ui=f}return ui};function jn(o,d){if(a)return re(19,1,o,d);o>>>=0,d>>>=0;var f,c=0,$=0;for(f of Fn()){var T=d+c;(x(),G)[o+$>>>2>>>0]=T,c+=pt(f,T,1/0)+1,$+=4}return 0}function Kn(o,d){if(a)return re(20,1,o,d);o>>>=0,d>>>=0;var f=Fn();for(var c of((x(),G)[o>>>2>>>0]=f.length,o=0,f))o+=gr(c)+1;return(x(),G)[d>>>2>>>0]=o,0}function Zn(o){return a?re(21,1,o):52}function Xn(o,d,f,c){return a?re(22,1,o,d,f,c):52}function Qn(o,d,f,c){return a?re(23,1,o,d,f,c):70}var Um=[null,[],[]];function Yn(o,d,f,c){if(a)return re(24,1,o,d,f,c);d>>>=0,f>>>=0,c>>>=0;for(var $=0,T=0;T<f;T++){var z=(x(),G)[d>>>2>>>0],B=(x(),G)[d+4>>>2>>>0];d+=8;for(var W=0;W<B;W++){var j=o,ne=(x(),P)[z+W>>>0],pe=Um[j];ne===0||ne===10?((j===1?k:E)(gn(pe)),pe.length=0):pe.push(ne)}$+=B}return(x(),G)[c>>>2>>>0]=$,0}function Pm(o){return o>>>0}a||(function(){for(var o=t.numThreads-1;o--;)ln();Oe.push(async()=>{var d=(async function(){if(!a)return Promise.all(lt.map(un))})();Ne++,await d,--Ne==0&&Re&&(d=Re,Re=null,d())})})(),a||(dt=new WebAssembly.Memory({initial:256,maximum:65536,shared:!0}),H()),t.wasmBinary&&(g=t.wasmBinary),t.stackSave=()=>ue(),t.stackRestore=o=>oe(o),t.stackAlloc=o=>ci(o),t.setValue=function(o,d,f="i8"){switch(f.endsWith("*")&&(f="*"),f){case"i1":case"i8":(x(),M)[o>>>0]=d;break;case"i16":(x(),K)[o>>>1>>>0]=d;break;case"i32":(x(),O)[o>>>2>>>0]=d;break;case"i64":(x(),he)[o>>>3>>>0]=BigInt(d);break;case"float":(x(),F)[o>>>2>>>0]=d;break;case"double":(x(),Y)[o>>>3>>>0]=d;break;case"*":(x(),G)[o>>>2>>>0]=d;break;default:L(`invalid type for setValue: ${f}`)}},t.getValue=function(o,d="i8"){switch(d.endsWith("*")&&(d="*"),d){case"i1":case"i8":return(x(),M)[o>>>0];case"i16":return(x(),K)[o>>>1>>>0];case"i32":return(x(),O)[o>>>2>>>0];case"i64":return(x(),he)[o>>>3>>>0];case"float":return(x(),F)[o>>>2>>>0];case"double":return(x(),Y)[o>>>3>>>0];case"*":return(x(),G)[o>>>2>>>0];default:L(`invalid type for getValue: ${d}`)}},t.UTF8ToString=ke,t.stringToUTF8=pt,t.lengthBytesUTF8=gr;var Jn,es,Sr,Je,Kt,di,ts,rs,is,pi,as,ns,le,Zt,ss,oe,ci,ue,os,hi,us,ls,ds,fi,ps,cs,hs,fs,ms,gs,ys,_s,bs,$s,ws,vs,xs,Ss,ks,Ts,Is,Es,zs,Cs,As,Os,Rs,Bs,Ns,Ms,Ds,Us,Ps,qs,Ls,Ws,Vs,Gs,Hs,Fs,js,Ks,Zs,at,qm=[Me,hr,cn,yn,_n,bn,$n,wn,vn,xn,Sn,kn,Tn,In,En,zn,Ln,Wn,Vn,jn,Kn,Zn,Xn,Qn,Yn],mi={1003524:(o,d,f,c,$)=>{if(t===void 0||!t.Xc)return 1;if((o=ke(Number(o>>>0))).startsWith("./")&&(o=o.substring(2)),!(o=t.Xc.get(o)))return 2;if(d=Number(d>>>0),f=Number(f>>>0),c=Number(c>>>0),d+f>o.byteLength)return 3;try{let T=o.subarray(d,d+f);switch($){case 0:(x(),P).set(T,c>>>0);break;case 1:t.Qd?t.Qd(c,T):t.Id(c,T);break;default:return 4}return 0}catch(T){return 4}},1004348:(o,d,f)=>{t.td(o,(x(),P).subarray(d>>>0,d+f>>>0))},1004412:()=>t.Sd(),1004454:o=>{t.sd(o)},1004491:()=>{t.Bd()},1004522:()=>{t.Cd()},1004551:()=>{t.Gd()},1004576:o=>t.Ad(o),1004609:o=>t.Ed(o),1004641:(o,d,f)=>{t.ed(Number(o),Number(d),Number(f),!0)},1004704:(o,d,f)=>{t.ed(Number(o),Number(d),Number(f))},1004761:()=>typeof wasmOffsetConverter<"u",1004818:o=>{t.$b("Abs",o,void 0)},1004869:o=>{t.$b("Neg",o,void 0)},1004920:o=>{t.$b("Floor",o,void 0)},1004973:o=>{t.$b("Ceil",o,void 0)},1005025:o=>{t.$b("Reciprocal",o,void 0)},1005083:o=>{t.$b("Sqrt",o,void 0)},1005135:o=>{t.$b("Exp",o,void 0)},1005186:o=>{t.$b("Erf",o,void 0)},1005237:o=>{t.$b("Sigmoid",o,void 0)},1005292:(o,d,f)=>{t.$b("HardSigmoid",o,{alpha:d,beta:f})},1005371:o=>{t.$b("Log",o,void 0)},1005422:o=>{t.$b("Sin",o,void 0)},1005473:o=>{t.$b("Cos",o,void 0)},1005524:o=>{t.$b("Tan",o,void 0)},1005575:o=>{t.$b("Asin",o,void 0)},1005627:o=>{t.$b("Acos",o,void 0)},1005679:o=>{t.$b("Atan",o,void 0)},1005731:o=>{t.$b("Sinh",o,void 0)},1005783:o=>{t.$b("Cosh",o,void 0)},1005835:o=>{t.$b("Asinh",o,void 0)},1005888:o=>{t.$b("Acosh",o,void 0)},1005941:o=>{t.$b("Atanh",o,void 0)},1005994:o=>{t.$b("Tanh",o,void 0)},1006046:o=>{t.$b("Not",o,void 0)},1006097:(o,d,f)=>{t.$b("Clip",o,{min:d,max:f})},1006166:o=>{t.$b("Clip",o,void 0)},1006218:(o,d)=>{t.$b("Elu",o,{alpha:d})},1006276:o=>{t.$b("Gelu",o,void 0)},1006328:o=>{t.$b("Relu",o,void 0)},1006380:(o,d)=>{t.$b("LeakyRelu",o,{alpha:d})},1006444:(o,d)=>{t.$b("ThresholdedRelu",o,{alpha:d})},1006514:(o,d)=>{t.$b("Cast",o,{to:d})},1006572:o=>{t.$b("Add",o,void 0)},1006623:o=>{t.$b("Sub",o,void 0)},1006674:o=>{t.$b("Mul",o,void 0)},1006725:o=>{t.$b("Div",o,void 0)},1006776:o=>{t.$b("Pow",o,void 0)},1006827:o=>{t.$b("Equal",o,void 0)},1006880:o=>{t.$b("Greater",o,void 0)},1006935:o=>{t.$b("GreaterOrEqual",o,void 0)},1006997:o=>{t.$b("Less",o,void 0)},1007049:o=>{t.$b("LessOrEqual",o,void 0)},1007108:(o,d,f,c,$)=>{t.$b("ReduceMean",o,{keepDims:!!d,noopWithEmptyAxes:!!f,axes:c?Array.from((x(),O).subarray(Number(c)>>>0,Number($)>>>0)):[]})},1007283:(o,d,f,c,$)=>{t.$b("ReduceMax",o,{keepDims:!!d,noopWithEmptyAxes:!!f,axes:c?Array.from((x(),O).subarray(Number(c)>>>0,Number($)>>>0)):[]})},1007457:(o,d,f,c,$)=>{t.$b("ReduceMin",o,{keepDims:!!d,noopWithEmptyAxes:!!f,axes:c?Array.from((x(),O).subarray(Number(c)>>>0,Number($)>>>0)):[]})},1007631:(o,d,f,c,$)=>{t.$b("ReduceProd",o,{keepDims:!!d,noopWithEmptyAxes:!!f,axes:c?Array.from((x(),O).subarray(Number(c)>>>0,Number($)>>>0)):[]})},1007806:(o,d,f,c,$)=>{t.$b("ReduceSum",o,{keepDims:!!d,noopWithEmptyAxes:!!f,axes:c?Array.from((x(),O).subarray(Number(c)>>>0,Number($)>>>0)):[]})},1007980:(o,d,f,c,$)=>{t.$b("ReduceL1",o,{keepDims:!!d,noopWithEmptyAxes:!!f,axes:c?Array.from((x(),O).subarray(Number(c)>>>0,Number($)>>>0)):[]})},1008153:(o,d,f,c,$)=>{t.$b("ReduceL2",o,{keepDims:!!d,noopWithEmptyAxes:!!f,axes:c?Array.from((x(),O).subarray(Number(c)>>>0,Number($)>>>0)):[]})},1008326:(o,d,f,c,$)=>{t.$b("ReduceLogSum",o,{keepDims:!!d,noopWithEmptyAxes:!!f,axes:c?Array.from((x(),O).subarray(Number(c)>>>0,Number($)>>>0)):[]})},1008503:(o,d,f,c,$)=>{t.$b("ReduceSumSquare",o,{keepDims:!!d,noopWithEmptyAxes:!!f,axes:c?Array.from((x(),O).subarray(Number(c)>>>0,Number($)>>>0)):[]})},1008683:(o,d,f,c,$)=>{t.$b("ReduceLogSumExp",o,{keepDims:!!d,noopWithEmptyAxes:!!f,axes:c?Array.from((x(),O).subarray(Number(c)>>>0,Number($)>>>0)):[]})},1008863:o=>{t.$b("Where",o,void 0)},1008916:(o,d,f)=>{t.$b("Transpose",o,{perm:d?Array.from((x(),O).subarray(Number(d)>>>0,Number(f)>>>0)):[]})},1009040:(o,d,f,c)=>{t.$b("DepthToSpace",o,{blocksize:d,mode:ke(f),format:c?"NHWC":"NCHW"})},1009173:(o,d,f,c)=>{t.$b("DepthToSpace",o,{blocksize:d,mode:ke(f),format:c?"NHWC":"NCHW"})},1009306:(o,d,f,c,$,T,z,B,W,j,ne,pe,ye,$e,ht)=>{t.$b("ConvTranspose",o,{format:W?"NHWC":"NCHW",autoPad:d,dilations:[f],group:c,kernelShape:[$],pads:[T,z],strides:[B],wIsConst:()=>!!(x(),M)[j>>>0],outputPadding:ne?Array.from((x(),O).subarray(Number(ne)>>>0,Number(pe)>>>0)):[],outputShape:ye?Array.from((x(),O).subarray(Number(ye)>>>0,Number($e)>>>0)):[],activation:ke(ht)})},1009739:(o,d,f,c,$,T,z,B,W,j,ne,pe,ye,$e)=>{t.$b("ConvTranspose",o,{format:B?"NHWC":"NCHW",autoPad:d,dilations:Array.from((x(),O).subarray(Number(f)>>>0,(Number(f)>>>0)+2>>>0)),group:c,kernelShape:Array.from((x(),O).subarray(Number($)>>>0,(Number($)>>>0)+2>>>0)),pads:Array.from((x(),O).subarray(Number(T)>>>0,(Number(T)>>>0)+4>>>0)),strides:Array.from((x(),O).subarray(Number(z)>>>0,(Number(z)>>>0)+2>>>0)),wIsConst:()=>!!(x(),M)[W>>>0],outputPadding:j?Array.from((x(),O).subarray(Number(j)>>>0,Number(ne)>>>0)):[],outputShape:pe?Array.from((x(),O).subarray(Number(pe)>>>0,Number(ye)>>>0)):[],activation:ke($e)})},1010400:(o,d,f,c,$,T,z,B,W,j,ne,pe,ye,$e,ht)=>{t.$b("ConvTranspose",o,{format:W?"NHWC":"NCHW",autoPad:d,dilations:[f],group:c,kernelShape:[$],pads:[T,z],strides:[B],wIsConst:()=>!!(x(),M)[j>>>0],outputPadding:ne?Array.from((x(),O).subarray(Number(ne)>>>0,Number(pe)>>>0)):[],outputShape:ye?Array.from((x(),O).subarray(Number(ye)>>>0,Number($e)>>>0)):[],activation:ke(ht)})},1010833:(o,d,f,c,$,T,z,B,W,j,ne,pe,ye,$e)=>{t.$b("ConvTranspose",o,{format:B?"NHWC":"NCHW",autoPad:d,dilations:Array.from((x(),O).subarray(Number(f)>>>0,(Number(f)>>>0)+2>>>0)),group:c,kernelShape:Array.from((x(),O).subarray(Number($)>>>0,(Number($)>>>0)+2>>>0)),pads:Array.from((x(),O).subarray(Number(T)>>>0,(Number(T)>>>0)+4>>>0)),strides:Array.from((x(),O).subarray(Number(z)>>>0,(Number(z)>>>0)+2>>>0)),wIsConst:()=>!!(x(),M)[W>>>0],outputPadding:j?Array.from((x(),O).subarray(Number(j)>>>0,Number(ne)>>>0)):[],outputShape:pe?Array.from((x(),O).subarray(Number(pe)>>>0,Number(ye)>>>0)):[],activation:ke($e)})},1011494:(o,d)=>{t.$b("GlobalAveragePool",o,{format:d?"NHWC":"NCHW"})},1011585:(o,d,f,c,$,T,z,B,W,j,ne,pe,ye,$e)=>{t.$b("AveragePool",o,{format:$e?"NHWC":"NCHW",auto_pad:d,ceil_mode:f,count_include_pad:c,storage_order:$,dilations:T?Array.from((x(),O).subarray(Number(T)>>>0,Number(z)>>>0)):[],kernel_shape:B?Array.from((x(),O).subarray(Number(B)>>>0,Number(W)>>>0)):[],pads:j?Array.from((x(),O).subarray(Number(j)>>>0,Number(ne)>>>0)):[],strides:pe?Array.from((x(),O).subarray(Number(pe)>>>0,Number(ye)>>>0)):[]})},1012064:(o,d)=>{t.$b("GlobalAveragePool",o,{format:d?"NHWC":"NCHW"})},1012155:(o,d,f,c,$,T,z,B,W,j,ne,pe,ye,$e)=>{t.$b("AveragePool",o,{format:$e?"NHWC":"NCHW",auto_pad:d,ceil_mode:f,count_include_pad:c,storage_order:$,dilations:T?Array.from((x(),O).subarray(Number(T)>>>0,Number(z)>>>0)):[],kernel_shape:B?Array.from((x(),O).subarray(Number(B)>>>0,Number(W)>>>0)):[],pads:j?Array.from((x(),O).subarray(Number(j)>>>0,Number(ne)>>>0)):[],strides:pe?Array.from((x(),O).subarray(Number(pe)>>>0,Number(ye)>>>0)):[]})},1012634:(o,d)=>{t.$b("GlobalMaxPool",o,{format:d?"NHWC":"NCHW"})},1012721:(o,d,f,c,$,T,z,B,W,j,ne,pe,ye,$e)=>{t.$b("MaxPool",o,{format:$e?"NHWC":"NCHW",auto_pad:d,ceil_mode:f,count_include_pad:c,storage_order:$,dilations:T?Array.from((x(),O).subarray(Number(T)>>>0,Number(z)>>>0)):[],kernel_shape:B?Array.from((x(),O).subarray(Number(B)>>>0,Number(W)>>>0)):[],pads:j?Array.from((x(),O).subarray(Number(j)>>>0,Number(ne)>>>0)):[],strides:pe?Array.from((x(),O).subarray(Number(pe)>>>0,Number(ye)>>>0)):[]})},1013196:(o,d)=>{t.$b("GlobalMaxPool",o,{format:d?"NHWC":"NCHW"})},1013283:(o,d,f,c,$,T,z,B,W,j,ne,pe,ye,$e)=>{t.$b("MaxPool",o,{format:$e?"NHWC":"NCHW",auto_pad:d,ceil_mode:f,count_include_pad:c,storage_order:$,dilations:T?Array.from((x(),O).subarray(Number(T)>>>0,Number(z)>>>0)):[],kernel_shape:B?Array.from((x(),O).subarray(Number(B)>>>0,Number(W)>>>0)):[],pads:j?Array.from((x(),O).subarray(Number(j)>>>0,Number(ne)>>>0)):[],strides:pe?Array.from((x(),O).subarray(Number(pe)>>>0,Number(ye)>>>0)):[]})},1013758:(o,d,f,c,$)=>{t.$b("Gemm",o,{alpha:d,beta:f,transA:c,transB:$})},1013862:o=>{t.$b("MatMul",o,void 0)},1013916:(o,d,f,c)=>{t.$b("ArgMax",o,{keepDims:!!d,selectLastIndex:!!f,axis:c})},1014024:(o,d,f,c)=>{t.$b("ArgMin",o,{keepDims:!!d,selectLastIndex:!!f,axis:c})},1014132:(o,d)=>{t.$b("Softmax",o,{axis:d})},1014195:(o,d)=>{t.$b("Concat",o,{axis:d})},1014255:(o,d,f,c,$)=>{t.$b("Split",o,{axis:d,numOutputs:f,splitSizes:c?Array.from((x(),O).subarray(Number(c)>>>0,Number($)>>>0)):[]})},1014411:o=>{t.$b("Expand",o,void 0)},1014465:(o,d)=>{t.$b("Gather",o,{axis:Number(d)})},1014536:(o,d)=>{t.$b("GatherElements",o,{axis:Number(d)})},1014615:(o,d)=>{t.$b("GatherND",o,{batch_dims:Number(d)})},1014694:(o,d,f,c,$,T,z,B,W,j,ne)=>{t.$b("Resize",o,{antialias:d,axes:f?Array.from((x(),O).subarray(Number(f)>>>0,Number(c)>>>0)):[],coordinateTransformMode:ke($),cubicCoeffA:T,excludeOutside:z,extrapolationValue:B,keepAspectRatioPolicy:ke(W),mode:ke(j),nearestMode:ke(ne)})},1015056:(o,d,f,c,$,T,z)=>{t.$b("Slice",o,{starts:d?Array.from((x(),O).subarray(Number(d)>>>0,Number(f)>>>0)):[],ends:c?Array.from((x(),O).subarray(Number(c)>>>0,Number($)>>>0)):[],axes:T?Array.from((x(),O).subarray(Number(T)>>>0,Number(z)>>>0)):[]})},1015320:o=>{t.$b("Tile",o,void 0)},1015372:(o,d,f)=>{t.$b("InstanceNormalization",o,{epsilon:d,format:f?"NHWC":"NCHW"})},1015486:(o,d,f)=>{t.$b("InstanceNormalization",o,{epsilon:d,format:f?"NHWC":"NCHW"})},1015600:o=>{t.$b("Range",o,void 0)},1015653:(o,d)=>{t.$b("Einsum",o,{equation:ke(d)})},1015734:(o,d,f,c,$)=>{t.$b("Pad",o,{mode:d,value:f,pads:c?Array.from((x(),O).subarray(Number(c)>>>0,Number($)>>>0)):[]})},1015877:(o,d,f,c,$,T)=>{t.$b("BatchNormalization",o,{epsilon:d,momentum:f,spatial:!!$,trainingMode:!!c,format:T?"NHWC":"NCHW"})},1016046:(o,d,f,c,$,T)=>{t.$b("BatchNormalization",o,{epsilon:d,momentum:f,spatial:!!$,trainingMode:!!c,format:T?"NHWC":"NCHW"})},1016215:(o,d,f)=>{t.$b("CumSum",o,{exclusive:Number(d),reverse:Number(f)})},1016312:(o,d,f)=>{t.$b("DequantizeLinear",o,{axis:d,blockSize:f})},1016402:(o,d,f,c,$)=>{t.$b("GridSample",o,{align_corners:d,mode:ke(f),padding_mode:ke(c),format:$?"NHWC":"NCHW"})},1016572:(o,d,f,c,$)=>{t.$b("GridSample",o,{align_corners:d,mode:ke(f),padding_mode:ke(c),format:$?"NHWC":"NCHW"})},1016742:(o,d)=>{t.$b("ScatterND",o,{reduction:ke(d)})},1016827:(o,d,f,c,$,T,z,B,W)=>{t.$b("Attention",o,{numHeads:d,isUnidirectional:f,maskFilterValue:c,scale:$,doRotary:T,qkvHiddenSizes:z?Array.from((x(),O).subarray(Number(B)>>>0,Number(B)+z>>>0)):[],pastPresentShareBuffer:!!W})},1017099:o=>{t.$b("BiasAdd",o,void 0)},1017154:o=>{t.$b("BiasSplitGelu",o,void 0)},1017215:o=>{t.$b("FastGelu",o,void 0)},1017271:(o,d,f,c,$,T,z,B,W,j,ne,pe,ye,$e,ht,gi)=>{t.$b("Conv",o,{format:pe?"NHWC":"NCHW",auto_pad:d,dilations:f?Array.from((x(),O).subarray(Number(f)>>>0,Number(c)>>>0)):[],group:$,kernel_shape:T?Array.from((x(),O).subarray(Number(T)>>>0,Number(z)>>>0)):[],pads:B?Array.from((x(),O).subarray(Number(B)>>>0,Number(W)>>>0)):[],strides:j?Array.from((x(),O).subarray(Number(j)>>>0,Number(ne)>>>0)):[],w_is_const:()=>!!(x(),M)[Number(ye)>>>0],activation:ke($e),activation_params:ht?Array.from((x(),F).subarray(Number(ht)>>>0,Number(gi)>>>0)):[]})},1017855:o=>{t.$b("Gelu",o,void 0)},1017907:(o,d,f,c,$,T,z,B,W)=>{t.$b("GroupQueryAttention",o,{numHeads:d,kvNumHeads:f,scale:c,softcap:$,doRotary:T,rotaryInterleaved:z,smoothSoftmax:B,localWindowSize:W})},1018124:(o,d,f,c)=>{t.$b("LayerNormalization",o,{axis:d,epsilon:f,simplified:!!c})},1018235:(o,d,f,c)=>{t.$b("LayerNormalization",o,{axis:d,epsilon:f,simplified:!!c})},1018346:(o,d,f,c,$,T)=>{t.$b("MatMulNBits",o,{k:d,n:f,accuracyLevel:c,bits:$,blockSize:T})},1018473:(o,d,f,c,$,T)=>{t.$b("MultiHeadAttention",o,{numHeads:d,isUnidirectional:f,maskFilterValue:c,scale:$,doRotary:T})},1018632:(o,d)=>{t.$b("QuickGelu",o,{alpha:d})},1018696:(o,d,f,c,$)=>{t.$b("RotaryEmbedding",o,{interleaved:!!d,numHeads:f,rotaryEmbeddingDim:c,scale:$})},1018835:(o,d,f)=>{t.$b("SkipLayerNormalization",o,{epsilon:d,simplified:!!f})},1018937:(o,d,f)=>{t.$b("SkipLayerNormalization",o,{epsilon:d,simplified:!!f})},1019039:(o,d,f,c)=>{t.$b("GatherBlockQuantized",o,{gatherAxis:d,quantizeAxis:f,blockSize:c})},1019160:o=>{t.Fd(o)},1019194:(o,d)=>t.Hd(Number(o),Number(d),t.Yc.Kd,t.Yc.errors)};function Lm(o,d,f){return Mn(async()=>{await t.Dd(Number(o),Number(d),Number(f))})}function Wm(){return typeof wasmOffsetConverter<"u"}function Vm(o,d,f,c){var $=ue();try{return _s(o,d,f,c)}catch(T){if(oe($),T!==T+0)throw T;le(1,0)}}function Gm(o,d,f){var c=ue();try{return fs(o,d,f)}catch($){if(oe(c),$!==$+0)throw $;le(1,0)}}function Hm(o){var d=ue();try{ps(o)}catch(f){if(oe(d),f!==f+0)throw f;le(1,0)}}function Fm(o,d){var f=ue();try{return fi(o,d)}catch(c){if(oe(f),c!==c+0)throw c;le(1,0)}}function jm(o,d,f){var c=ue();try{ds(o,d,f)}catch($){if(oe(c),$!==$+0)throw $;le(1,0)}}function Km(o,d){var f=ue();try{bs(o,d)}catch(c){if(oe(f),c!==c+0)throw c;le(1,0)}}function Zm(o,d,f,c,$,T,z){var B=ue();try{return gs(o,d,f,c,$,T,z)}catch(W){if(oe(B),W!==W+0)throw W;le(1,0)}}function Xm(o,d,f,c,$,T){var z=ue();try{cs(o,d,f,c,$,T)}catch(B){if(oe(z),B!==B+0)throw B;le(1,0)}}function Qm(o,d,f,c){var $=ue();try{ys(o,d,f,c)}catch(T){if(oe($),T!==T+0)throw T;le(1,0)}}function Ym(o,d,f,c,$){var T=ue();try{hs(o,d,f,c,$)}catch(z){if(oe(T),z!==z+0)throw z;le(1,0)}}function Jm(o,d,f,c,$,T,z){var B=ue();try{ws(o,d,f,c,$,T,z)}catch(W){if(oe(B),W!==W+0)throw W;le(1,0)}}function eg(o,d,f,c,$,T,z){var B=ue();try{vs(o,d,f,c,$,T,z)}catch(W){if(oe(B),W!==W+0)throw W;le(1,0)}}function tg(o,d,f,c,$,T,z,B){var W=ue();try{Ts(o,d,f,c,$,T,z,B)}catch(j){if(oe(W),j!==j+0)throw j;le(1,0)}}function rg(o,d,f,c,$){var T=ue();try{return $s(o,d,f,c,$)}catch(z){if(oe(T),z!==z+0)throw z;le(1,0)}}function ig(o,d,f){var c=ue();try{return Is(o,d,f)}catch($){if(oe(c),$!==$+0)throw $;le(1,0)}}function ag(o,d,f,c,$,T,z,B){var W=ue();try{Es(o,d,f,c,$,T,z,B)}catch(j){if(oe(W),j!==j+0)throw j;le(1,0)}}function ng(o,d,f,c,$,T,z,B,W,j,ne,pe){var ye=ue();try{xs(o,d,f,c,$,T,z,B,W,j,ne,pe)}catch($e){if(oe(ye),$e!==$e+0)throw $e;le(1,0)}}function sg(o,d,f,c,$,T){var z=ue();try{return Ss(o,d,f,c,$,T)}catch(B){if(oe(z),B!==B+0)throw B;le(1,0)}}function og(o,d,f){var c=ue();try{return zs(o,d,f)}catch($){if(oe(c),$!==$+0)throw $;return le(1,0),BigInt(0)}}function ug(o,d,f,c,$,T,z,B,W){var j=ue();try{ms(o,d,f,c,$,T,z,B,W)}catch(ne){if(oe(j),ne!==ne+0)throw ne;le(1,0)}}function lg(o){var d=ue();try{return Cs(o)}catch(f){if(oe(d),f!==f+0)throw f;le(1,0)}}function dg(o,d){var f=ue();try{return Hs(o,d)}catch(c){if(oe(f),c!==c+0)throw c;return le(1,0),BigInt(0)}}function pg(o){var d=ue();try{return As(o)}catch(f){if(oe(d),f!==f+0)throw f;return le(1,0),BigInt(0)}}function cg(o,d,f,c){var $=ue();try{return Ds(o,d,f,c)}catch(T){if(oe($),T!==T+0)throw T;le(1,0)}}function hg(o,d,f,c,$){var T=ue();try{return Us(o,d,f,c,$)}catch(z){if(oe(T),z!==z+0)throw z;le(1,0)}}function fg(o,d,f,c,$,T){var z=ue();try{return Ps(o,d,f,c,$,T)}catch(B){if(oe(z),B!==B+0)throw B;le(1,0)}}function mg(o,d,f,c,$,T){var z=ue();try{return qs(o,d,f,c,$,T)}catch(B){if(oe(z),B!==B+0)throw B;le(1,0)}}function gg(o,d,f,c,$,T,z,B){var W=ue();try{return ks(o,d,f,c,$,T,z,B)}catch(j){if(oe(W),j!==j+0)throw j;le(1,0)}}function yg(o,d,f,c,$){var T=ue();try{return Ls(o,d,f,c,$)}catch(z){if(oe(T),z!==z+0)throw z;return le(1,0),BigInt(0)}}function _g(o,d,f,c){var $=ue();try{return Ws(o,d,f,c)}catch(T){if(oe($),T!==T+0)throw T;le(1,0)}}function bg(o,d,f,c){var $=ue();try{return Vs(o,d,f,c)}catch(T){if(oe($),T!==T+0)throw T;le(1,0)}}function $g(o,d,f,c,$,T,z,B,W,j,ne,pe){var ye=ue();try{return Gs(o,d,f,c,$,T,z,B,W,j,ne,pe)}catch($e){if(oe(ye),$e!==$e+0)throw $e;le(1,0)}}function wg(o,d,f,c,$,T,z,B,W,j,ne){var pe=ue();try{Ns(o,d,f,c,$,T,z,B,W,j,ne)}catch(ye){if(oe(pe),ye!==ye+0)throw ye;le(1,0)}}function vg(o,d,f,c,$,T,z,B,W,j,ne,pe,ye,$e,ht,gi){var Tg=ue();try{Ms(o,d,f,c,$,T,z,B,W,j,ne,pe,ye,$e,ht,gi)}catch(yi){if(oe(Tg),yi!==yi+0)throw yi;le(1,0)}}function xg(o,d,f){var c=ue();try{return Os(o,d,f)}catch($){if(oe(c),$!==$+0)throw $;le(1,0)}}function Sg(o,d,f){var c=ue();try{return Rs(o,d,f)}catch($){if(oe(c),$!==$+0)throw $;le(1,0)}}function kg(o,d,f,c){var $=ue();try{Bs(o,d,f,c)}catch(T){if(oe($),T!==T+0)throw T;le(1,0)}}function kr(){if(0<Ne)Re=kr;else if(a)b==null||b(t),X();else{for(var o=Oe;0<o.length;)o.shift()(t);0<Ne?Re=kr:(t.calledRun=!0,A||(X(),b==null||b(t)))}}return a||(at=await qe(),kr()),t.PTR_SIZE=4,q?t:new Promise((o,d)=>{b=o,S=d})}var ip,ro,Kg=U(()=>{var e,t;ip=to,ro=(t=(e=globalThis.self)==null?void 0:e.name)==null?void 0:t.startsWith("em-pthread"),ro&&to()}),xi,fa,io,De,ap,Ir,ao,no,Si,so,ki,np,Ti,sp,Ra=U(()=>{Oa(),xi=typeof location>"u"?void 0:location.origin,fa=import.meta.url>"file:"&&import.meta.url<"file;",io=()=>{{if(fa){let e=URL;return new URL(new e("ort.bundle.min.mjs",import.meta.url).href,xi).href}return import.meta.url}},De=io(),ap=()=>{if(De&&!De.startsWith("blob:"))return De.substring(0,De.lastIndexOf("/")+1)},Ir=(e,t)=>{try{let r=t!=null?t:De;return(r?new URL(e,r):new URL(e)).origin===xi}catch(r){return!1}},ao=(e,t)=>{let r=t!=null?t:De;try{return(r?new URL(e,r):new URL(e)).href}catch(i){return}},no=(e,t)=>`${t!=null?t:"./"}${e}`,Si=async e=>{let t=await(await fetch(e,{credentials:"same-origin"})).blob();return URL.createObjectURL(t)},so=async e=>(await import(e)).default,ki=(jg(),pr(ep)).default,np=async()=>{if(!De)throw new Error("Failed to load proxy worker: cannot determine the script source URL.");if(Ir(De))return[void 0,ki()];let e=await Si(De);return[e,ki(e)]},Ti=(Kg(),pr(rp)).default,sp=async(e,t,r,i)=>{let a=Ti&&!(e||t);if(a)if(De)a=Ir(De)||i&&!r;else if(i&&!r)a=!0;else throw new Error("cannot determine the script source URL.");if(a)return[void 0,Ti];{let s="ort-wasm-simd-threaded.jsep.mjs",n=e!=null?e:ao(s,t),u=r&&n&&!Ir(n,t),l=u?await Si(n):n!=null?n:no(s,t);return[u?l:void 0,await so(l)]}}}),Ii,Er,Qt,Ei,oo,uo,lo,Ba,_e,Nt=U(()=>{Ra(),Er=!1,Qt=!1,Ei=!1,oo=()=>{if(typeof SharedArrayBuffer>"u")return!1;try{return typeof MessageChannel<"u"&&new MessageChannel().port1.postMessage(new SharedArrayBuffer(1)),WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,5,4,1,3,1,1,10,11,1,9,0,65,0,254,16,2,0,26,11]))}catch(e){return!1}},uo=()=>{try{return WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,10,30,1,28,0,65,0,253,15,253,12,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,253,186,1,26,11]))}catch(e){return!1}},lo=()=>{try{return WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,19,1,17,0,65,1,253,15,65,2,253,15,65,3,253,15,253,147,2,11]))}catch(e){return!1}},Ba=async e=>{var b,S;if(Er)return Promise.resolve();if(Qt)throw new Error("multiple calls to 'initializeWebAssembly()' detected.");if(Ei)throw new Error("previous call to 'initializeWebAssembly()' failed.");Qt=!0;let t=e.initTimeout,r=e.numThreads;if(e.simd!==!1){if(e.simd==="relaxed"){if(!lo())throw new Error("Relaxed WebAssembly SIMD is not supported in the current environment.")}else if(!uo())throw new Error("WebAssembly SIMD is not supported in the current environment.")}let i=oo();r>1&&!i&&(typeof self<"u"&&!self.crossOriginIsolated&&console.warn("env.wasm.numThreads is set to "+r+", but this will not work unless you enable crossOriginIsolated mode. See https://web.dev/cross-origin-isolation-guide/ for more info."),console.warn("WebAssembly multi-threading is not supported in the current environment. Falling back to single-threading."),e.numThreads=r=1);let a=e.wasmPaths,s=typeof a=="string"?a:void 0,n=a==null?void 0:a.mjs,u=(b=n==null?void 0:n.href)!=null?b:n,l=a==null?void 0:a.wasm,p=(S=l==null?void 0:l.href)!=null?S:l,h=e.wasmBinary,[m,g]=await sp(u,s,r>1,!!h||!!p),y=!1,_=[];if(t>0&&_.push(new Promise(v=>{setTimeout(()=>{y=!0,v()},t)})),_.push(new Promise((v,w)=>{let I={numThreads:r};if(h)I.wasmBinary=h,I.locateFile=k=>k;else if(p||s)I.locateFile=k=>p!=null?p:s+k;else if(u&&u.indexOf("blob:")!==0)I.locateFile=k=>new URL(k,u).href;else if(m){let k=ap();k&&(I.locateFile=E=>k+E)}g(I).then(k=>{Qt=!1,Er=!0,Ii=k,v(),m&&URL.revokeObjectURL(m)},k=>{Qt=!1,Ei=!0,w(k)})})),await Promise.race(_),y)throw new Error(`WebAssembly backend initializing failed due to timeout: ${t}ms`)},_e=()=>{if(Er&&Ii)return Ii;throw new Error("WebAssembly is not initialized yet.")}}),Ze,Wr,ge,Na=U(()=>{Nt(),Ze=(e,t)=>{let r=_e(),i=r.lengthBytesUTF8(e)+1,a=r._malloc(i);return r.stringToUTF8(e,a,i),t.push(a),a},Wr=(e,t,r,i)=>{if(typeof e=="object"&&e!==null){if(r.has(e))throw new Error("Circular reference in options");r.add(e)}Object.entries(e).forEach(([a,s])=>{let n=t?t+a:a;if(typeof s=="object")Wr(s,n+".",r,i);else if(typeof s=="string"||typeof s=="number")i(n,s.toString());else if(typeof s=="boolean")i(n,s?"1":"0");else throw new Error(`Can't handle extra config type: ${typeof s}`)})},ge=e=>{let t=_e(),r=t.stackSave();try{let i=t.PTR_SIZE,a=t.stackAlloc(2*i);t._OrtGetLastError(a,a+i);let s=Number(t.getValue(a,i===4?"i32":"i64")),n=t.getValue(a+i,"*"),u=n?t.UTF8ToString(n):"";throw new Error(`${e} ERROR_CODE: ${s}, ERROR_MESSAGE: ${u}`)}finally{t.stackRestore(r)}}}),op,Zg=U(()=>{Nt(),Na(),op=e=>{let t=_e(),r=0,i=[],a=e||{};try{if((e==null?void 0:e.logSeverityLevel)===void 0)a.logSeverityLevel=2;else if(typeof e.logSeverityLevel!="number"||!Number.isInteger(e.logSeverityLevel)||e.logSeverityLevel<0||e.logSeverityLevel>4)throw new Error(`log severity level is not valid: ${e.logSeverityLevel}`);if((e==null?void 0:e.logVerbosityLevel)===void 0)a.logVerbosityLevel=0;else if(typeof e.logVerbosityLevel!="number"||!Number.isInteger(e.logVerbosityLevel))throw new Error(`log verbosity level is not valid: ${e.logVerbosityLevel}`);(e==null?void 0:e.terminate)===void 0&&(a.terminate=!1);let s=0;return(e==null?void 0:e.tag)!==void 0&&(s=Ze(e.tag,i)),r=t._OrtCreateRunOptions(a.logSeverityLevel,a.logVerbosityLevel,!!a.terminate,s),r===0&&ge("Can't create run options."),(e==null?void 0:e.extra)!==void 0&&Wr(e.extra,"",new WeakSet,(n,u)=>{let l=Ze(n,i),p=Ze(u,i);t._OrtAddRunConfigEntry(r,l,p)!==0&&ge(`Can't set a run config entry: ${n} - ${u}.`)}),[r,i]}catch(s){throw r!==0&&t._OrtReleaseRunOptions(r),i.forEach(n=>t._free(n)),s}}}),po,co,ho,vt,fo,up,Xg=U(()=>{Nt(),Na(),po=e=>{switch(e){case"disabled":return 0;case"basic":return 1;case"extended":return 2;case"layout":return 3;case"all":return 99;default:throw new Error(`unsupported graph optimization level: ${e}`)}},co=e=>{switch(e){case"sequential":return 0;case"parallel":return 1;default:throw new Error(`unsupported execution mode: ${e}`)}},ho=e=>{e.extra||(e.extra={}),e.extra.session||(e.extra.session={});let t=e.extra.session;t.use_ort_model_bytes_directly||(t.use_ort_model_bytes_directly="1"),e.executionProviders&&e.executionProviders.some(r=>(typeof r=="string"?r:r.name)==="webgpu")&&(e.enableMemPattern=!1)},vt=(e,t,r,i)=>{let a=Ze(t,i),s=Ze(r,i);_e()._OrtAddSessionConfigEntry(e,a,s)!==0&&ge(`Can't set a session config entry: ${t} - ${r}.`)},fo=async(e,t,r)=>{let i=t.executionProviders;for(let a of i){let s=typeof a=="string"?a:a.name,n=[];switch(s){case"webnn":if(s="WEBNN",vt(e,"session.disable_quant_qdq","1",r),vt(e,"session.disable_qdq_constant_folding","1",r),typeof a!="string"){let m=a==null?void 0:a.deviceType;m&&vt(e,"deviceType",m,r)}break;case"webgpu":if(s="JS",typeof a!="string"){let m=a;if(m!=null&&m.preferredLayout){if(m.preferredLayout!=="NCHW"&&m.preferredLayout!=="NHWC")throw new Error(`preferredLayout must be either 'NCHW' or 'NHWC': ${m.preferredLayout}`);vt(e,"preferredLayout",m.preferredLayout,r)}}break;case"wasm":case"cpu":continue;default:throw new Error(`not supported execution provider: ${s}`)}let u=Ze(s,r),l=n.length,p=0,h=0;if(l>0){p=_e()._malloc(l*_e().PTR_SIZE),r.push(p),h=_e()._malloc(l*_e().PTR_SIZE),r.push(h);for(let m=0;m<l;m++)_e().setValue(p+m*_e().PTR_SIZE,n[m][0],"*"),_e().setValue(h+m*_e().PTR_SIZE,n[m][1],"*")}await _e()._OrtAppendExecutionProvider(e,u,p,h,l)!==0&&ge(`Can't append execution provider: ${s}.`)}},up=async e=>{var s,n,u,l;let t=_e(),r=0,i=[],a=e||{};ho(a);try{let p=po((s=a.graphOptimizationLevel)!=null?s:"all"),h=co((n=a.executionMode)!=null?n:"sequential"),m=typeof a.logId=="string"?Ze(a.logId,i):0,g=(u=a.logSeverityLevel)!=null?u:2;if(!Number.isInteger(g)||g<0||g>4)throw new Error(`log severity level is not valid: ${g}`);let y=(l=a.logVerbosityLevel)!=null?l:0;if(!Number.isInteger(y)||y<0||y>4)throw new Error(`log verbosity level is not valid: ${y}`);let _=typeof a.optimizedModelFilePath=="string"?Ze(a.optimizedModelFilePath,i):0;if(r=t._OrtCreateSessionOptions(p,!!a.enableCpuMemArena,!!a.enableMemPattern,h,!!a.enableProfiling,0,m,g,y,_),r===0&&ge("Can't create session options."),a.executionProviders&&await fo(r,a,i),a.enableGraphCapture!==void 0){if(typeof a.enableGraphCapture!="boolean")throw new Error(`enableGraphCapture must be a boolean value: ${a.enableGraphCapture}`);vt(r,"enableGraphCapture",a.enableGraphCapture.toString(),i)}if(a.freeDimensionOverrides)for(let[b,S]of Object.entries(a.freeDimensionOverrides)){if(typeof b!="string")throw new Error(`free dimension override name must be a string: ${b}`);if(typeof S!="number"||!Number.isInteger(S)||S<0)throw new Error(`free dimension override value must be a non-negative integer: ${S}`);let v=Ze(b,i);t._OrtAddFreeDimensionOverride(r,v,S)!==0&&ge(`Can't set a free dimension override: ${b} - ${S}.`)}return a.extra!==void 0&&Wr(a.extra,"",new WeakSet,(b,S)=>{vt(r,b,S,i)}),[r,i]}catch(p){throw r!==0&&t._OrtReleaseSessionOptions(r)!==0&&ge("Can't release session options."),i.forEach(h=>t._free(h)),p}}}),Et,st,zt,Zr,Vr,Ma,Da,ma,te=U(()=>{Et=e=>{switch(e){case"int8":return 3;case"uint8":return 2;case"bool":return 9;case"int16":return 5;case"uint16":return 4;case"int32":return 6;case"uint32":return 12;case"float16":return 10;case"float32":return 1;case"float64":return 11;case"string":return 8;case"int64":return 7;case"uint64":return 13;case"int4":return 22;case"uint4":return 21;default:throw new Error(`unsupported data type: ${e}`)}},st=e=>{switch(e){case 3:return"int8";case 2:return"uint8";case 9:return"bool";case 5:return"int16";case 4:return"uint16";case 6:return"int32";case 12:return"uint32";case 10:return"float16";case 1:return"float32";case 11:return"float64";case 8:return"string";case 7:return"int64";case 13:return"uint64";case 22:return"int4";case 21:return"uint4";default:throw new Error(`unsupported data type: ${e}`)}},zt=(e,t)=>{let r=[-1,4,1,1,2,2,4,8,-1,1,2,8,4,8,-1,-1,-1,-1,-1,-1,-1,.5,.5][e],i=typeof t=="number"?t:t.reduce((a,s)=>a*s,1);return r>0?Math.ceil(i*r):void 0},Zr=e=>{switch(e){case"float16":return typeof Float16Array<"u"?Float16Array:Uint16Array;case"float32":return Float32Array;case"uint8":return Uint8Array;case"int8":return Int8Array;case"uint16":return Uint16Array;case"int16":return Int16Array;case"int32":return Int32Array;case"bool":return Uint8Array;case"float64":return Float64Array;case"uint32":return Uint32Array;case"int64":return BigInt64Array;case"uint64":return BigUint64Array;default:throw new Error(`unsupported type: ${e}`)}},Vr=e=>{switch(e){case"verbose":return 0;case"info":return 1;case"warning":return 2;case"error":return 3;case"fatal":return 4;default:throw new Error(`unsupported logging level: ${e}`)}},Ma=e=>e==="float32"||e==="float16"||e==="int32"||e==="int64"||e==="uint32"||e==="uint8"||e==="bool"||e==="uint4"||e==="int4",Da=e=>e==="float32"||e==="float16"||e==="int32"||e==="int64"||e==="uint32"||e==="uint64"||e==="int8"||e==="uint8"||e==="bool"||e==="uint4"||e==="int4",ma=e=>{switch(e){case"none":return 0;case"cpu":return 1;case"cpu-pinned":return 2;case"texture":return 3;case"gpu-buffer":return 4;case"ml-tensor":return 5;default:throw new Error(`unsupported data location: ${e}`)}}}),Ua,lp=U(()=>{Oa(),Ua=async e=>{if(typeof e=="string"){let t=await fetch(e);if(!t.ok)throw new Error(`failed to load external data file: ${e}`);let r=t.headers.get("Content-Length"),i=r?parseInt(r,10):0;if(i<1073741824)return new Uint8Array(await t.arrayBuffer());{if(!t.body)throw new Error(`failed to load external data file: ${e}, no response body.`);let a=t.body.getReader(),s;try{s=new ArrayBuffer(i)}catch(u){if(u instanceof RangeError){let l=Math.ceil(i/65536);s=new WebAssembly.Memory({initial:l,maximum:l}).buffer}else throw u}let n=0;for(;;){let{done:u,value:l}=await a.read();if(u)break;let p=l.byteLength;new Uint8Array(s,n,p).set(l),n+=p}return new Uint8Array(s,0,i)}}else return e instanceof Blob?new Uint8Array(await e.arrayBuffer()):e instanceof Uint8Array?e:new Uint8Array(e)}}),mo,go,yo,_o,Pa,bo,de,ot=U(()=>{te(),mo=["V","I","W","E","F"],go=(e,t)=>{console.log(`[${mo[e]},${new Date().toISOString()}]${t}`)},Pa=(e,t)=>{yo=e,_o=t},bo=(e,t)=>{let r=Vr(e),i=Vr(yo);r>=i&&go(r,typeof t=="function"?t():t)},de=(...e)=>{_o&&bo(...e)}}),$o,Wt,R,Gr,dp,pp,cp,ie=U(()=>{$o=class{static calcMatMulShape(e,t){return e[1]!==t[0]?void 0:[e[0],t[1]]}},Wt=class{static calcShape(e,t,r=!1){let i=e.length,a=t.length;if(i===0)return t;if(a===0)return e;let s=Math.max(e.length,t.length),n=new Array(s);if(r){if(i<2||a<2)return;let u=$o.calcMatMulShape([e[i-2],e[i-1]],[t[a-2],t[a-1]]);if(u===void 0)return;[n[s-2],n[s-1]]=u}for(let u=r?3:1;u<=s;u++){let l=i-u<0?1:e[i-u],p=a-u<0?1:t[a-u];if(l!==p&&l>1&&p>1)return;let h=Math.max(l,p);if(l&&p)n[s-u]=Math.max(l,p);else{if(h>1)return;n[s-u]=0}}return n}static isValidBroadcast(e,t){let r=e.length,i=t.length;if(r>i)return!1;for(let a=1;a<=r;a++)if(e[r-a]!==1&&e[r-a]!==t[i-a])return!1;return!0}},R=class Pr{static size(t){return Pr.getSizeFromDimensionRange(t,0,t.length)}static convertShape(t,r=4){let i=t.length;if(i===0)return[];let a=new Array(i),s=i-1;for(;s>=0;){if(t[s]%r===0){a[s]=t[s]/r;break}if(r%t[s]!==0)throw new Error("cannot convert shape");a[s]=1,r/=t[s],s--}for(s--;s>=0;s--)a[s]=t[s];return a}static sizeFromDimension(t,r){if(r<0||r>t.length)throw new Error(`invalid dimension of ${r} for sizeFromDimension as Tensor has ${t.length} dimensions.`);return Pr.getSizeFromDimensionRange(t,r,t.length)}static sizeToDimension(t,r){if(r<0||r>t.length)throw new Error(`invalid dimension of ${r} for sizeToDimension as Tensor has ${t.length} dimensions.`);return Pr.getSizeFromDimensionRange(t,0,r)}static getSizeFromDimensionRange(t,r,i){let a=1;for(let s=r;s<i;s++){if(t[s]<0)throw new Error("cannot get valid size from specified dimension range. Most likely the range contains negative values in them.");a*=Number(t[s])}return a}static computeStrides(t){let r=t.length;if(r===0)return[];if(r===1)return[1];let i=new Array(r);i[r-1]=1,i[r-2]=t[r-1];for(let a=r-3;a>=0;--a)i[a]=i[a+1]*t[a+1];return i}static normalizeAxis(t,r){if(t<-r&&t>=r)throw new Error("unsupported axis for this operation.");return t<0?t+r:t}static normalizeAxes(t,r){return t.map(i=>this.normalizeAxis(i,r!=null?r:t.length))}static sortBasedOnPerm(t,r){return r?r.map(i=>t[i]):t.slice().reverse()}static padShape(t,r){let i=t.length;return t.map((a,s)=>a+r[s]+r[s+i])}static areEqual(t,r){return t.length!==r.length?!1:t.every((i,a)=>i===r[a])}},Gr=class or{static adjustPoolAttributes(t,r,i,a,s,n){if(!t&&i.length!==r.length-2)throw new Error("length of specified kernel shapes should be 2 less than length of input dimensions");if(t)for(let u=0;u<r.length-2;u++)u>=i.length?i.push(r[u+2]):i[u]=r[u+2];for(let u=0;u<i.length;u++)if(u<a.length){if(a[u]<0)throw new Error("strides should be greater than or equal to 1")}else a.push(1);for(let u=0;u<i.length;u++)if(u<s.length){if(s[u]<0)throw new Error("dilations should be greater than or equal to 1")}else s.push(1);for(let u=0;u<i.length*2;u++)if(u<n.length){if(n[u]<0)throw new Error("pad should be greater than or equal to 1")}else n.push(0);for(let u=0;u<i.length;u++){if(i[u]<=0)throw new Error("kernel shapes need to be greater than 0");if(n[u]>=i[u]||n[u+i.length]>=i[u])throw new Error("pads should be smaller than kernel")}}static adjustPadsBasedOnAutoPad(t,r,i,a,s,n,u){if(u){if(s.length!==2*(t.length-2))throw new Error("length of pads should be twice the length of data dimensions");if(r.length!==t.length-2)throw new Error("length of strides should be the length of data dimensions");if(a.length!==t.length-2)throw new Error("length of kernel shapes should be the length of data dimensions");for(let l=0;l<t.length-2;l++)or.adjustPadAndReturnShape(t[l+(n?1:2)],r[l],i[l],a[l],s,l,l+t.length-2,u)}}static computePoolOutputShape(t,r,i,a,s,n,u){if(r.length<=0)throw new Error("input shape must be of size greater than 0");let l=[r[0],r[1]];return or.computeShapeHelper(t,r,l,i,a,s,n,u),l}static computeConvOutputShape(t,r,i,a,s,n,u){if(t.length<=0||r.length<=0)throw new Error("invalid input tensor dims or invalid filter tensor dims");let l=[t[0],r[0]];return or.computeShapeHelper(!1,t,l,i,a,s,n,u),l}static computeShapeHelper(t,r,i,a,s,n,u,l){if(t)for(let p=0;p<r.length-2;p++)i.push(1);else for(let p=0;p<r.length-2;p++)i.push(or.adjustPadAndReturnShape(r[p+2],a[p],s[p],n[p],u,p,p+r.length-2,l))}static adjustPadAndReturnShape(t,r,i,a,s,n,u,l){let p=i*(a-1)+1;if(l&&l!=="NOTSET")switch(l){case"VALID":return s[n]=0,s[u]=0,Math.floor((t-p)/r+1);case"SAME_LOWER":case"SAME_UPPER":if(i!==1)throw new Error("Dilation not supported for SAME_UPPER or SAME_LOWER");{let h=((t+r-1)/r-1)*r+a-t;return s[n]=Math.floor(l==="SAME_LOWER"?(h+1)/2:h/2),s[u]=h-s[n],Math.floor((t+h-a)/r+1)}default:throw new Error("Unsupported AutoPad type")}else return Math.floor((t+s[n]+s[u]-p)/r+1)}},dp=class{static getShapeOfGemmResult(e,t,r,i,a){if(e.length!==2||r.length!==2)throw new Error("shape need to be of size 2");let s,n,u;t?(s=e[1],n=e[0]):(s=e[0],n=e[1]);let l=-1;if(i?(u=r[0],l=1):(u=r[1],l=0),r[l]!==n)throw new Error("dimension mismatch");if(s<=0||u<=0||n<=0)throw new Error("invalid shape specified");if(a&&!Wt.isValidBroadcast(a,[s,u]))throw new Error("gemm: invalid bias shape for broadcast");return[s,u,n]}},pp=-34028234663852886e22,cp=34028234663852886e22}),qa,hp=U(()=>{te(),qa=(e,t)=>new(Zr(t))(e)}),zi,ga,Ci,wo,Ai,vo,Oi,Ri,Bi,xo,fp,Qg=U(()=>{te(),ot(),zi=new Map([["float32",32],["float16",16],["int32",32],["uint32",32],["int64",64],["uint64",64],["int8",8],["uint8",8],["int4",4],["uint4",4]]),ga=(e,t)=>{if(t==="int32")return e;let r=zi.get(t);if(!r)throw new Error(`WebNN backend does not support data type: ${t}`);let i=r/8;if(e.byteLength%i!==0)throw new Error(`Invalid Uint8Array length - must be a multiple of ${i}.`);let a=e.byteLength/i,s=new(Zr(t))(e.buffer,e.byteOffset,a);switch(t){case"int64":case"uint64":{let n=new Int32Array(a);for(let u=0;u<a;u++){let l=s[u];if(l>BigInt(2147483647)||l<-BigInt(2147483648))throw new Error("Can not convert int64 data to int32 - value out of range.");n[u]=Number(l)}return new Uint8Array(n.buffer)}case"int8":case"uint8":case"uint32":{if(t==="uint32"&&s.some(u=>u>2147483647))throw new Error("Can not convert uint32 data to int32 - value out of range.");let n=Int32Array.from(s,Number);return new Uint8Array(n.buffer)}default:throw new Error(`Unsupported data conversion from ${t} to 'int32'`)}},Ci=(e,t)=>{if(t==="int32")return e;if(e.byteLength%4!==0)throw new Error("Invalid Uint8Array length - must be a multiple of 4 (int32).");let r=e.byteLength/4,i=new Int32Array(e.buffer,e.byteOffset,r);switch(t){case"int64":{let a=BigInt64Array.from(i,BigInt);return new Uint8Array(a.buffer)}case"uint64":{if(i.some(s=>s<0))throw new Error("Can not convert int32 data to uin64 - negative value found.");let a=BigUint64Array.from(i,BigInt);return new Uint8Array(a.buffer)}case"int8":{if(i.some(s=>s<-128||s>127))throw new Error("Can not convert int32 data to int8 - value out of range.");let a=Int8Array.from(i,Number);return new Uint8Array(a.buffer)}case"uint8":{if(i.some(a=>a<0||a>255))throw new Error("Can not convert int32 data to uint8 - value out of range.");return Uint8Array.from(i,Number)}case"uint32":{if(i.some(s=>s<0))throw new Error("Can not convert int32 data to uint32 - negative value found.");let a=Uint32Array.from(i,Number);return new Uint8Array(a.buffer)}default:throw new Error(`Unsupported data conversion from 'int32' to ${t}`)}},wo=1,Ai=()=>wo++,vo=new Map([["int8","int32"],["uint8","int32"],["uint32","int32"],["int64","int32"]]),Oi=(e,t)=>{let r=zi.get(e);if(!r)throw new Error(`WebNN backend does not support data type: ${e}`);return t.length>0?Math.ceil(t.reduce((i,a)=>i*a)*r/8):0},Ri=class{constructor(e){this.isDataConverted=!1;let{sessionId:t,context:r,tensor:i,dataType:a,shape:s,fallbackDataType:n}=e;this.sessionId=t,this.mlContext=r,this.mlTensor=i,this.dataType=a,this.tensorShape=s,this.fallbackDataType=n}get tensor(){return this.mlTensor}get type(){return this.dataType}get fallbackType(){return this.fallbackDataType}get shape(){return this.tensorShape}get byteLength(){return Oi(this.dataType,this.tensorShape)}destroy(){de("verbose",()=>"[WebNN] TensorWrapper.destroy"),this.mlTensor.destroy()}write(e){this.mlContext.writeTensor(this.mlTensor,e)}async read(e){if(this.fallbackDataType){let t=await this.mlContext.readTensor(this.mlTensor),r=Ci(new Uint8Array(t),this.dataType);if(e){(e instanceof ArrayBuffer?new Uint8Array(e):new Uint8Array(e.buffer,e.byteOffset,e.byteLength)).set(r);return}else return new Uint8Array(r).buffer}else return e?this.mlContext.readTensor(this.mlTensor,e):this.mlContext.readTensor(this.mlTensor)}canReuseTensor(e,t,r){return this.mlContext===e&&this.dataType===t&&this.tensorShape.length===r.length&&this.tensorShape.every((i,a)=>i===r[a])}setIsDataConverted(e){this.isDataConverted=e}},Bi=class{constructor(e,t){this.tensorManager=e,this.wrapper=t}get tensorWrapper(){return this.wrapper}releaseTensor(){this.tensorWrapper&&(this.tensorManager.releaseTensor(this.tensorWrapper),this.wrapper=void 0)}async ensureTensor(e,t,r,i){let a=this.tensorManager.getMLContext(e),s=this.tensorManager.getMLOpSupportLimits(e),n;if(!(s!=null&&s.input.dataTypes.includes(t))){if(n=vo.get(t),!n||(s==null?void 0:s.input.dataTypes.includes(n)))throw new Error(`WebNN backend does not support data type: ${t}`);de("verbose",()=>`[WebNN] TensorIdTracker.ensureTensor: fallback dataType from ${t} to ${n}`)}if(this.wrapper){if(this.wrapper.canReuseTensor(a,t,r))return this.wrapper.tensor;if(i){if(this.wrapper.byteLength!==Oi(t,r))throw new Error("Unable to copy data to tensor with different size.");this.activeUpload=new Uint8Array(await this.wrapper.read())}this.tensorManager.releaseTensor(this.wrapper)}let u=typeof MLTensorUsage>"u"?void 0:MLTensorUsage.READ|MLTensorUsage.WRITE;return this.wrapper=await this.tensorManager.getCachedTensor(e,t,r,u,!0,!0,n),i&&this.activeUpload&&(this.wrapper.write(this.activeUpload),this.activeUpload=void 0),this.wrapper.tensor}upload(e){let t=e;if(this.wrapper){if(this.wrapper.fallbackType)if(this.wrapper.fallbackType==="int32")t=ga(e,this.wrapper.type),this.wrapper.setIsDataConverted(!0);else throw new Error(`Unsupported fallback data type: ${this.wrapper.fallbackType}`);if(e.byteLength===this.wrapper.byteLength){this.wrapper.write(t);return}else de("verbose",()=>"Data size does not match tensor size. Releasing tensor."),this.releaseTensor()}this.activeUpload?this.activeUpload.set(t):this.activeUpload=new Uint8Array(t)}async download(e){var t,r;if(this.activeUpload){let i=(t=this.wrapper)!=null&&t.isDataConverted?Ci(this.activeUpload,(r=this.wrapper)==null?void 0:r.type):this.activeUpload;if(e){e instanceof ArrayBuffer?new Uint8Array(e).set(i):new Uint8Array(e.buffer,e.byteOffset,e.byteLength).set(i);return}else return i.buffer}if(!this.wrapper)throw new Error("Tensor has not been created.");return e?this.wrapper.read(e):this.wrapper.read()}},xo=class{constructor(e){this.backend=e,this.tensorTrackersById=new Map,this.freeTensors=[],this.externalTensors=new Set}getMLContext(e){let t=this.backend.getMLContext(e);if(!t)throw new Error("MLContext not found for session.");return t}getMLOpSupportLimits(e){return this.backend.getMLOpSupportLimits(e)}reserveTensorId(){let e=Ai();return this.tensorTrackersById.set(e,new Bi(this)),e}releaseTensorId(e){let t=this.tensorTrackersById.get(e);t&&(this.tensorTrackersById.delete(e),t.tensorWrapper&&this.releaseTensor(t.tensorWrapper))}async ensureTensor(e,t,r,i,a){de("verbose",()=>`[WebNN] TensorManager.ensureTensor {tensorId: ${t}, dataType: ${r}, shape: ${i}, copyOld: ${a}}`);let s=this.tensorTrackersById.get(t);if(!s)throw new Error("Tensor not found.");return s.ensureTensor(e,r,i,a)}upload(e,t){let r=this.tensorTrackersById.get(e);if(!r)throw new Error("Tensor not found.");r.upload(t)}async download(e,t){de("verbose",()=>`[WebNN] TensorManager.download {tensorId: ${e}, dstBuffer: ${t==null?void 0:t.byteLength}}`);let r=this.tensorTrackersById.get(e);if(!r)throw new Error("Tensor not found.");return r.download(t)}releaseTensorsForSession(e){for(let t of this.freeTensors)t.sessionId===e&&t.destroy();this.freeTensors=this.freeTensors.filter(t=>t.sessionId!==e)}registerTensor(e,t,r,i){let a=this.getMLContext(e),s=Ai(),n=new Ri({sessionId:e,context:a,tensor:t,dataType:r,shape:i});return this.tensorTrackersById.set(s,new Bi(this,n)),this.externalTensors.add(n),s}async getCachedTensor(e,t,r,i,a,s,n){let u=this.getMLContext(e);for(let[p,h]of this.freeTensors.entries())if(h.canReuseTensor(u,t,r)){de("verbose",()=>`[WebNN] Reusing tensor {dataType: ${t}, ${n?`fallbackDataType: ${n},`:""} shape: ${r}`);let m=this.freeTensors.splice(p,1)[0];return m.sessionId=e,m}de("verbose",()=>`[WebNN] MLContext.createTensor {dataType: ${t}, ${n?`fallbackDataType: ${n},`:""} shape: ${r}}`);let l=await u.createTensor({dataType:n!=null?n:t,shape:r,dimensions:r,usage:i,writable:a,readable:s});return new Ri({sessionId:e,context:u,tensor:l,dataType:t,shape:r,fallbackDataType:n})}releaseTensor(e){this.externalTensors.has(e)&&this.externalTensors.delete(e),this.freeTensors.push(e)}},fp=(...e)=>new xo(...e)}),Yt,So,mp,Yg=U(()=>{te(),Nt(),hp(),Qg(),ot(),Yt=new Map([[1,"float32"],[10,"float16"],[6,"int32"],[12,"uint32"],[7,"int64"],[13,"uint64"],[22,"int4"],[21,"uint4"],[3,"int8"],[2,"uint8"],[9,"uint8"]]),So=(e,t)=>{if(e===t)return!0;if(e===void 0||t===void 0)return!1;let r=Object.keys(e).sort(),i=Object.keys(t).sort();return r.length===i.length&&r.every((a,s)=>a===i[s]&&e[a]===t[a])},mp=class{constructor(e){this.tensorManager=fp(this),this.mlContextBySessionId=new Map,this.sessionIdsByMLContext=new Map,this.mlContextCache=[],this.sessionGraphInputs=new Map,this.sessionGraphOutputs=new Map,this.temporaryGraphInputs=[],this.temporaryGraphOutputs=[],this.temporarySessionTensorIds=new Map,this.mlOpSupportLimitsBySessionId=new Map,Pa(e.logLevel,!!e.debug)}get currentSessionId(){if(this.activeSessionId===void 0)throw new Error("No active session");return this.activeSessionId}onRunStart(e){de("verbose",()=>`[WebNN] onRunStart {sessionId: ${e}}`),this.activeSessionId=e}onRunEnd(e){de("verbose",()=>`[WebNN] onRunEnd {sessionId: ${e}}`);let t=this.temporarySessionTensorIds.get(e);if(t){for(let r of t)de("verbose",()=>`[WebNN] releasing temporary tensor {tensorId: ${r}}`),this.tensorManager.releaseTensorId(r);this.temporarySessionTensorIds.delete(e),this.activeSessionId=void 0}}async createMLContext(e){if(e instanceof GPUDevice){let r=this.mlContextCache.findIndex(i=>i.gpuDevice===e);if(r!==-1)return this.mlContextCache[r].mlContext;{let i=await navigator.ml.createContext(e);return this.mlContextCache.push({gpuDevice:e,mlContext:i}),i}}else if(e===void 0){let r=this.mlContextCache.findIndex(i=>i.options===void 0&&i.gpuDevice===void 0);if(r!==-1)return this.mlContextCache[r].mlContext;{let i=await navigator.ml.createContext();return this.mlContextCache.push({mlContext:i}),i}}let t=this.mlContextCache.findIndex(r=>So(r.options,e));if(t!==-1)return this.mlContextCache[t].mlContext;{let r=await navigator.ml.createContext(e);return this.mlContextCache.push({options:e,mlContext:r}),r}}registerMLContext(e,t){this.mlContextBySessionId.set(e,t);let r=this.sessionIdsByMLContext.get(t);r||(r=new Set,this.sessionIdsByMLContext.set(t,r)),r.add(e),this.mlOpSupportLimitsBySessionId.has(e)||this.mlOpSupportLimitsBySessionId.set(e,t.opSupportLimits()),this.temporaryGraphInputs.length>0&&(this.sessionGraphInputs.set(e,this.temporaryGraphInputs),this.temporaryGraphInputs=[]),this.temporaryGraphOutputs.length>0&&(this.sessionGraphOutputs.set(e,this.temporaryGraphOutputs),this.temporaryGraphOutputs=[])}onReleaseSession(e){this.sessionGraphInputs.delete(e),this.sessionGraphOutputs.delete(e);let t=this.mlContextBySessionId.get(e);if(!t)return;this.tensorManager.releaseTensorsForSession(e),this.mlContextBySessionId.delete(e),this.mlOpSupportLimitsBySessionId.delete(e);let r=this.sessionIdsByMLContext.get(t);if(r.delete(e),r.size===0){this.sessionIdsByMLContext.delete(t);let i=this.mlContextCache.findIndex(a=>a.mlContext===t);i!==-1&&this.mlContextCache.splice(i,1)}}getMLContext(e){return this.mlContextBySessionId.get(e)}getMLOpSupportLimits(e){return this.mlOpSupportLimitsBySessionId.get(e)}reserveTensorId(){return this.tensorManager.reserveTensorId()}releaseTensorId(e){de("verbose",()=>`[WebNN] releaseTensorId {tensorId: ${e}}`),this.tensorManager.releaseTensorId(e)}async ensureTensor(e,t,r,i,a){let s=Yt.get(r);if(!s)throw new Error(`Unsupported ONNX data type: ${r}`);return this.tensorManager.ensureTensor(e!=null?e:this.currentSessionId,t,s,i,a)}async createTemporaryTensor(e,t,r){de("verbose",()=>`[WebNN] createTemporaryTensor {onnxDataType: ${t}, shape: ${r}}`);let i=Yt.get(t);if(!i)throw new Error(`Unsupported ONNX data type: ${t}`);let a=this.tensorManager.reserveTensorId();await this.tensorManager.ensureTensor(e,a,i,r,!1);let s=this.temporarySessionTensorIds.get(e);return s?s.push(a):this.temporarySessionTensorIds.set(e,[a]),a}uploadTensor(e,t){if(!_e().shouldTransferToMLTensor)throw new Error("Trying to upload to a MLTensor while shouldTransferToMLTensor is false");de("verbose",()=>`[WebNN] uploadTensor {tensorId: ${e}, data: ${t.byteLength}}`),this.tensorManager.upload(e,t)}async downloadTensor(e,t){return this.tensorManager.download(e,t)}createMLTensorDownloader(e,t){return async()=>{let r=await this.tensorManager.download(e);return qa(r,t)}}registerMLTensor(e,t,r,i){let a=Yt.get(r);if(!a)throw new Error(`Unsupported ONNX data type: ${r}`);let s=this.tensorManager.registerTensor(e,t,a,i);return de("verbose",()=>`[WebNN] registerMLTensor {tensor: ${t}, dataType: ${a}, dimensions: ${i}} -> {tensorId: ${s}}`),s}registerMLConstant(e,t,r,i,a,s,n=!1){if(!s)throw new Error("External mounted files are not available.");let u=e;e.startsWith("./")&&(u=e.substring(2));let l=s.get(u);if(!l)throw new Error(`File with name ${u} not found in preloaded files.`);if(t+r>l.byteLength)throw new Error("Out of bounds: data offset and length exceed the external file data size.");let p=l.slice(t,t+r).buffer,h;switch(a.dataType){case"float32":h=new Float32Array(p);break;case"float16":h=typeof Float16Array<"u"?new Float16Array(p):new Uint16Array(p);break;case"int32":h=new Int32Array(p);break;case"uint32":h=new Uint32Array(p);break;case"int64":if(n){let m=ga(new Uint8Array(p),"int64");h=new Int32Array(m.buffer),a.dataType="int32"}else h=new BigInt64Array(p);break;case"uint64":h=new BigUint64Array(p);break;case"int8":h=new Int8Array(p);break;case"int4":case"uint4":case"uint8":h=new Uint8Array(p);break;default:throw new Error(`Unsupported data type: ${a.dataType} in creating WebNN Constant from external data.`)}return de("verbose",()=>`[WebNN] registerMLConstant {dataType: ${a.dataType}, shape: ${a.shape}}} ${n?"(Note: it was int64 data type and registered to int32 as workaround)":""}`),i.constant(a,h)}registerGraphInput(e){this.temporaryGraphInputs.push(e)}registerGraphOutput(e){this.temporaryGraphOutputs.push(e)}isGraphInput(e,t){let r=this.sessionGraphInputs.get(e);return r?r.includes(t):!1}isGraphOutput(e,t){let r=this.sessionGraphOutputs.get(e);return r?r.includes(t):!1}isGraphInputOutputTypeSupported(e,t,r=!0){let i=Yt.get(Et(t)),a=this.mlOpSupportLimitsBySessionId.get(e);return typeof i>"u"?!1:r?!!(a!=null&&a.input.dataTypes.includes(i)):!!(a!=null&&a.output.dataTypes.includes(i))}flush(){}}}),La=U(()=>{}),Ni,zr,Cr,ko,To,Mi,ya,Io,gp,Jg=U(()=>{ot(),La(),Ni=new Map([[64,250],[128,200],[256,200],[512,200],[2048,230],[4096,200],[8192,50],[16384,50],[32768,50],[65536,50],[131072,50],[262144,50],[524288,50],[1048576,50],[2097152,30],[4194304,20],[8388608,10],[12582912,10],[16777216,10],[26214400,15],[33554432,22],[44236800,2],[58982400,6],[67108864,6],[134217728,6],[167772160,6]]),zr=[],Cr=e=>Math.ceil(Number(e)/16)*16,ko=e=>{for(let t=0;t<zr.length;t++){let r=zr[t];if(e<=r)return r}return Math.ceil(e/16)*16},To=1,Mi=()=>To++,ya=async(e,t,r,i)=>{let a=Cr(r),s=e.device.createBuffer({size:a,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});try{let n=e.getCommandEncoder();e.endComputePass(),n.copyBufferToBuffer(t,0,s,0,a),e.flush(),await s.mapAsync(GPUMapMode.READ);let u=s.getMappedRange();if(i){let l=i();return l.set(new Uint8Array(u,0,r)),l}else return new Uint8Array(u.slice(0,r))}finally{s.destroy()}},Io=class{constructor(e){this.backend=e,this.storageCache=new Map,this.freeBuffers=new Map,this.freeUniformBuffers=new Map,this.buffersPending=[],this.capturedPendingBuffers=new Map;for(let[t]of Ni)zr.push(t),this.freeBuffers.set(t,[]),this.freeUniformBuffers.set(t,[]);this.sessionCount=0}upload(e,t){let r=t.buffer,i=t.byteOffset,a=t.byteLength,s=Cr(a),n=this.storageCache.get(e);if(!n)throw new Error("gpu data for uploading does not exist");if(Number(n.originalSize)!==a)throw new Error(`inconsistent data size. gpu data size=${n.originalSize}, data size=${a}`);let u=this.backend.device.createBuffer({mappedAtCreation:!0,size:s,usage:GPUBufferUsage.MAP_WRITE|GPUBufferUsage.COPY_SRC}),l=u.getMappedRange();new Uint8Array(l).set(new Uint8Array(r,i,a)),u.unmap();let p=this.backend.device.createCommandEncoder();p.copyBufferToBuffer(u,0,n.gpuData.buffer,0,s),this.backend.device.queue.submit([p.finish()]),u.destroy(),de("verbose",()=>`[WebGPU] GpuDataManager.upload(id=${e})`)}memcpy(e,t){let r=this.storageCache.get(e);if(!r)throw new Error("source gpu data for memcpy does not exist");let i=this.storageCache.get(t);if(!i)throw new Error("destination gpu data for memcpy does not exist");if(r.originalSize!==i.originalSize)throw new Error("inconsistent source and destination gpu data size");let a=Cr(r.originalSize),s=this.backend.getCommandEncoder();this.backend.endComputePass(),s.copyBufferToBuffer(r.gpuData.buffer,0,i.gpuData.buffer,0,a)}registerExternalBuffer(e,t,r){let i;if(r){if(i=r[0],e===r[1])return de("verbose",()=>`[WebGPU] GpuDataManager.registerExternalBuffer(size=${t}) => id=${i}, buffer is the same, skip.`),i;if(this.backend.capturedCommandList.has(this.backend.currentSessionId))throw new Error(`Registering a different external buffer under graph capture mode is not supported yet.
             Please use the previous external buffer!`)}else i=Mi();return this.storageCache.set(i,{gpuData:{id:i,type:0,buffer:e},originalSize:t}),de("verbose",()=>`[WebGPU] GpuDataManager.registerExternalBuffer(size=${t}) => id=${i}, registered.`),i}unregisterExternalBuffer(e){e!==void 0&&(this.storageCache.delete(e),de("verbose",()=>`[WebGPU] GpuDataManager.unregisterExternalBuffer() => id=${e}`))}create(e,t=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST){let r=ko(e),i,a=(t&GPUBufferUsage.STORAGE)===GPUBufferUsage.STORAGE,s=(t&GPUBufferUsage.UNIFORM)===GPUBufferUsage.UNIFORM;if(a||s){let u=(a?this.freeBuffers:this.freeUniformBuffers).get(r);u?u.length>0?i=u.pop():i=this.backend.device.createBuffer({size:r,usage:t}):i=this.backend.device.createBuffer({size:r,usage:t})}else i=this.backend.device.createBuffer({size:r,usage:t});let n={id:Mi(),type:0,buffer:i};return this.storageCache.set(n.id,{gpuData:n,originalSize:Number(e)}),de("verbose",()=>`[WebGPU] GpuDataManager.create(size=${e}) => id=${n.id}`),n}get(e){var t;return(t=this.storageCache.get(e))==null?void 0:t.gpuData}release(e){let t=typeof e=="bigint"?Number(e):e,r=this.storageCache.get(t);if(!r){if(this.storageCache.size===0)return 0;throw new Error("releasing data does not exist")}return de("verbose",()=>`[WebGPU] GpuDataManager.release(id=${t}), gpuDataId=${r.gpuData.id}`),this.storageCache.delete(t),this.buffersPending.push(r.gpuData.buffer),r.originalSize}async download(e,t){let r=this.storageCache.get(Number(e));if(!r)throw new Error("data does not exist");await ya(this.backend,r.gpuData.buffer,r.originalSize,t)}refreshPendingBuffers(){if(this.buffersPending.length!==0)if(this.backend.sessionStatus==="default"){for(let e of this.buffersPending){let t=Ni.get(e.size);if((e.usage&GPUBufferUsage.STORAGE)===GPUBufferUsage.STORAGE){let r=this.freeBuffers.get(e.size)||[];t===void 0||r.length>=t?e.destroy():r.push(e)}else if((e.usage&GPUBufferUsage.UNIFORM)===GPUBufferUsage.UNIFORM){let r=this.freeUniformBuffers.get(e.size)||[];t===void 0||r.length>=t?e.destroy():r.push(e)}else e.destroy()}this.buffersPending=[]}else{let e=this.capturedPendingBuffers.get(this.backend.currentSessionId);e||(e=[],this.capturedPendingBuffers.set(this.backend.currentSessionId,e));for(let t of this.buffersPending)e.push(t);this.buffersPending=[]}}dispose(){this.freeBuffers.forEach(e=>{e.forEach(t=>{t.destroy()})}),this.freeUniformBuffers.forEach(e=>{e.forEach(t=>{t.destroy()})}),this.storageCache.forEach(e=>{e.gpuData.buffer.destroy()}),this.capturedPendingBuffers.forEach(e=>{e.forEach(t=>{t.destroy()})}),this.storageCache=new Map,this.freeBuffers=new Map,this.freeUniformBuffers=new Map,this.capturedPendingBuffers=new Map}onCreateSession(){this.sessionCount+=1}onReleaseSession(e){let t=this.capturedPendingBuffers.get(e);t&&(t.forEach(r=>{r.destroy()}),this.capturedPendingBuffers.delete(e)),this.sessionCount-=1,this.sessionCount===0&&(de("warning",()=>"[WebGPU] Clearing webgpu buffer cache"),this.storageCache.forEach(r=>{r.gpuData.buffer.destroy()}),this.storageCache=new Map)}},gp=(...e)=>new Io(...e)}),Eo,fe,xe=U(()=>{Eo=class{constructor(e){Object.assign(this,e)}get cacheKey(){return this.key||(this.key=Object.getOwnPropertyNames(this).sort().map(e=>`${this[e]}`).join(";")),this.key}},fe=e=>new Eo(e)}),Vt,Ar,Te,ze,ee,ve,_a,Lt,yt,J,Jt,N,Q,yp,Wa,zo,_p,ae=U(()=>{te(),ie(),Vt=64,Ar=(e,t)=>{if(t===3)throw new Error("vec3 has same alignment as vec4, use vec4 instead");switch(Number(e)){case 10:return t>1?`vec${t}<f16>`:"f16";case 1:return t>1?`vec${t}<f32>`:"f32";case 6:return t>1?`vec${t}<i32>`:"i32";case 12:return t>1?`vec${t}<u32>`:"u32";case 7:if(t>1)throw new Error("currently not supported vecX of uint64 yet");return["vec2<u32>","i32"];case 13:if(t>1)throw new Error("currently not supported vecX of uint64 yet");return["vec2<u32>","u32"];case 9:if(t!==4)throw new Error("bool must be vec4");return["u32","vec4<bool>"];case 22:return"i32";case 21:return"u32";default:throw new Error(`Unknown data type: ${e}`)}},Te=(e,t=1)=>{let r=Ar(e,t);return typeof r=="string"?r:r[0]},ze=(e,t=1)=>{let r=Ar(e,t);return typeof r=="string"?r:r[1]},ee=(...e)=>{let t=[];return e.forEach(r=>{r.length!==0&&t.push({type:12,data:r},{type:12,data:R.computeStrides(r)})}),t},ve=e=>e%4===0?4:e%2===0?2:1,_a=(e="f32",t,r="0")=>!t||t===1?`${e}(${r})`:`vec${t}<${e}>(${r})`,Lt=(e,t,r)=>e==="f32"?r:t===1?`f32(${r})`:`vec${t}<f32>(${r})`,yt=(e,t)=>t===4?`(${e}.x + ${e}.y + ${e}.z + ${e}.w)`:t===2?`(${e}.x + ${e}.y)`:t===3?`(${e}.x + ${e}.y + ${e}.z)`:e,J=(e,t,r,i)=>e.startsWith("uniforms.")&&r>4?typeof t=="string"?i==="f16"?`${e}[(${t}) / 8][(${t}) % 8 / 4][(${t}) % 8 % 4]`:`${e}[(${t}) / 4][(${t}) % 4]`:i==="f16"?`${e}[${Math.floor(t/8)}][${Math.floor(t%8/4)}][${t%8%4}]`:`${e}[${Math.floor(t/4)}][${t%4}]`:r>1?`${e}[${t}]`:e,Jt=(e,t,r,i,a)=>{let s=typeof r=="number",n=s?r:r.length,u=[...new Array(n).keys()],l=n<2?"u32":n<=4?`vec${n}<u32>`:`array<u32, ${n}>`,p=Ar(t,a),h=typeof p=="string"?p:p[1],m=typeof p=="string"?p:p[0],g={indices:l,value:h,storage:m,tensor:t},y=q=>typeof q=="string"?q:`${q}u`,_={offsetToIndices:!1,indicesToOffset:!1,broadcastedIndicesToOffset:!1,set:!1,setByIndices:!1,get:!1,getByIndices:!1},b=s?"uniforms.":"",S=`${b}${e}_shape`,v=`${b}${e}_strides`,w="";for(let q=0;q<n-1;q++)w+=`
    let dim${q} = current / ${J(v,q,n)};
    let rest${q} = current % ${J(v,q,n)};
    indices[${q}] = dim${q};
    current = rest${q};
    `;w+=`indices[${n-1}] = current;`;let I=n<2?"":`
  fn o2i_${e}(offset: u32) -> ${g.indices} {
    var indices: ${g.indices};
    var current = offset;
    ${w}
    return indices;
  }`,k=q=>(_.offsetToIndices=!0,n<2?q:`o2i_${e}(${q})`),E=[];if(n>=2)for(let q=n-1;q>=0;q--)E.push(`${J(v,q,n)} * (indices[${q}])`);let A=n<2?"":`
  fn i2o_${e}(indices: ${g.indices}) -> u32 {
    return ${E.join("+")};
  }`,C=q=>(_.indicesToOffset=!0,n<2?q:`i2o_${e}(${q})`),x=(...q)=>n===0?"0u":`${g.indices}(${q.map(y).join(",")})`,D=(q,H)=>n<2?`${q}`:`${J(q,H,n)}`,M=(q,H,X)=>n<2?`${q}=${X};`:`${J(q,H,n)}=${X};`,P={},K=(q,H)=>{_.broadcastedIndicesToOffset=!0;let X=`${H.name}broadcastedIndicesTo${e}Offset`;if(X in P)return`${X}(${q})`;let L=[];for(let me=n-1;me>=0;me--){let qe=H.indicesGet("outputIndices",me+H.rank-n);L.push(`${D(v,me)} * (${qe} % ${D(S,me)})`)}return P[X]=`fn ${X}(outputIndices: ${H.type.indices}) -> u32 {
             return ${L.length>0?L.join("+"):"0u"};
           }`,`${X}(${q})`},Z=(q,H)=>(()=>{if(g.storage===g.value)return`${e}[${q}]=${H};`;if(g.storage==="vec2<u32>"&&g.value==="i32")return`${e}[${q}]=vec2<u32>(u32(${H}), select(0u, 0xFFFFFFFFu, ${H} < 0));`;if(g.storage==="vec2<u32>"&&g.value==="u32")return`${e}[${q}]=vec2<u32>(u32(${H}), 0u);`;if(g.storage==="u32"&&g.value==="vec4<bool>")return`${e}[${q}]=dot(vec4<u32>(0x1, 0x100, 0x10000, 0x1000000), vec4<u32>(${H}));`;throw new Error(`not supported combination of storage type ${g.storage} and value type ${g.value} yet`)})(),O=q=>(()=>{if(g.storage===g.value)return`${e}[${q}]`;if(g.storage==="vec2<u32>"&&g.value==="i32")return`i32(${e}[${q}].x)`;if(g.storage==="vec2<u32>"&&g.value==="u32")return`u32(${e}[${q}].x)`;if(g.storage==="u32"&&g.value==="vec4<bool>")return`vec4<bool>(bool(${e}[${q}] & 0xFFu), bool(${e}[${q}] & 0xFF00u), bool(${e}[${q}] & 0xFF0000u), bool(${e}[${q}] & 0xFF000000u))`;throw new Error(`not supported combination of storage type ${g.storage} and value type ${g.value} yet`)})(),G=n<2?"":`
  fn get_${e}ByIndices(indices: ${g.indices}) -> ${h} {
    return ${O(`i2o_${e}(indices)`)};
  }`,F=n<2?"":(()=>{let q=u.map(X=>`d${X}: u32`).join(", "),H=u.map(X=>`d${X}`).join(", ");return`
  fn get_${e}(${q}) -> ${h} {
    return get_${e}ByIndices(${x(H)});
  }`})(),Y=(...q)=>{if(q.length!==n)throw new Error(`indices length must be ${n}`);let H=q.map(y).join(",");return n===0?O("0u"):n===1?O(H[0]):(_.get=!0,_.getByIndices=!0,_.indicesToOffset=!0,`get_${e}(${H})`)},he=q=>n<2?O(q):(_.getByIndices=!0,_.indicesToOffset=!0,`get_${e}ByIndices(${q})`),V=n<2?"":`
  fn set_${e}ByIndices(indices: ${g.indices}, value: ${h}) {
    ${Z(`i2o_${e}(indices)`,"value")}
  }`,se=n<2?"":(()=>{let q=u.map(X=>`d${X}: u32`).join(", "),H=u.map(X=>`d${X}`).join(", ");return`
  fn set_${e}(${q}, value: ${h}) {
    set_${e}ByIndices(${x(H)}, value);
  }`})();return{impl:()=>{let q=[],H=!1;return _.offsetToIndices&&(q.push(I),H=!0),_.indicesToOffset&&(q.push(A),H=!0),_.broadcastedIndicesToOffset&&(Object.values(P).forEach(X=>q.push(X)),H=!0),_.set&&(q.push(se),H=!0),_.setByIndices&&(q.push(V),H=!0),_.get&&(q.push(F),H=!0),_.getByIndices&&(q.push(G),H=!0),!s&&H&&q.unshift(`const ${S} = ${g.indices}(${r.join(",")});`,`const ${v} = ${g.indices}(${R.computeStrides(r).join(",")});`),q.join(`
`)},type:g,offsetToIndices:k,indicesToOffset:C,broadcastedIndicesToOffset:K,indices:x,indicesGet:D,indicesSet:M,set:(...q)=>{if(q.length!==n+1)throw new Error(`indices length must be ${n}`);let H=q[n];if(typeof H!="string")throw new Error("value must be string");let X=q.slice(0,n).map(y).join(",");return n===0?Z("0u",H):n===1?Z(X[0],H):(_.set=!0,_.setByIndices=!0,_.indicesToOffset=!0,`set_${e}(${X}, ${H})`)},setByOffset:Z,setByIndices:(q,H)=>n<2?Z(q,H):(_.setByIndices=!0,_.indicesToOffset=!0,`set_${e}ByIndices(${q}, ${H});`),get:Y,getByOffset:O,getByIndices:he,usage:i,name:e,strides:v,shape:S,rank:n}},N=(e,t,r,i=1)=>Jt(e,t,r,"input",i),Q=(e,t,r,i=1)=>Jt(e,t,r,"output",i),yp=(e,t,r)=>Jt(e,t,r,"atomicOutput",1),Wa=(e,t,r,i=1)=>Jt(e,t,r,"internal",i),zo=class{constructor(e,t){this.normalizedDispatchGroup=e,this.limits=t,this.internalVariables=[],this.variables=[],this.uniforms=[],this.variableIndex=0}guardAgainstOutOfBoundsWorkgroupSizes(e){return`if (global_idx >= ${typeof e=="number"?`${e}u`:e}) { return; }`}mainStart(e=Vt){let t=typeof e=="number"?e:e[0],r=typeof e=="number"?1:e[1],i=typeof e=="number"?1:e[2];if(t>this.limits.maxComputeWorkgroupSizeX||r>this.limits.maxComputeWorkgroupSizeY||i>this.limits.maxComputeWorkgroupSizeZ)throw new Error(`workgroup size [${t}, ${r}, ${i}] exceeds the maximum workgroup size [${this.limits.maxComputeWorkgroupSizeX}, ${this.limits.maxComputeWorkgroupSizeY}, ${this.limits.maxComputeWorkgroupSizeZ}].`);if(t*r*i>this.limits.maxComputeInvocationsPerWorkgroup)throw new Error(`workgroup size [${t}, ${r}, ${i}] exceeds the maximum workgroup invocations ${this.limits.maxComputeInvocationsPerWorkgroup}.`);let a=this.normalizedDispatchGroup[1]===1&&this.normalizedDispatchGroup[2]===1,s=a?`@builtin(global_invocation_id) global_id : vec3<u32>,
    @builtin(workgroup_id) workgroup_id : vec3<u32>,
    @builtin(local_invocation_index) local_idx : u32,
    @builtin(local_invocation_id) local_id : vec3<u32>`:`@builtin(global_invocation_id) global_id : vec3<u32>,
                                             @builtin(local_invocation_id) local_id : vec3<u32>,
    @builtin(local_invocation_index) local_idx : u32,
    @builtin(workgroup_id) workgroup_id : vec3<u32>,
    @builtin(num_workgroups) num_workgroups : vec3<u32>`,n=a?`let global_idx = global_id.x;
         let workgroup_index = workgroup_id.x;`:`let workgroup_index = workgroup_id.z * num_workgroups[0] * num_workgroups[1] +
             workgroup_id.y * num_workgroups[0] + workgroup_id.x;
         let global_idx = workgroup_index * ${t*r*i}u + local_idx;`;return`@compute @workgroup_size(${t}, ${r}, ${i})
  fn main(${s}) {
    ${n}
  `}appendVariableUniforms(e){e.rank!==0&&(e.shape.startsWith("uniforms.")&&this.uniforms.push({name:e.shape.replace("uniforms.",""),type:"u32",length:e.rank}),e.strides.startsWith("uniforms.")&&this.uniforms.push({name:e.strides.replace("uniforms.",""),type:"u32",length:e.rank}))}declareVariable(e,t){if(e.usage==="internal")throw new Error("cannot use internal variable with declareVariable(). use registerInternalVariables() instead.");this.variables.push(e),this.appendVariableUniforms(e);let r=e.usage==="input"?"read":"read_write",i=e.usage==="atomicOutput"?"atomic<i32>":e.type.storage;return`@group(0) @binding(${t}) var<storage, ${r}> ${e.name}: array<${i}>;`}declareVariables(...e){return e.map(t=>this.declareVariable(t,this.variableIndex++)).join(`
`)}registerInternalVariable(e){if(e.usage!=="internal")throw new Error("cannot use input or output variable with registerInternalVariable(). use declareVariables() instead.");this.internalVariables.push(e),this.appendVariableUniforms(e)}registerInternalVariables(...e){return e.forEach(t=>this.registerInternalVariable(t)),this}registerUniform(e,t,r=1){return this.uniforms.push({name:e,type:t,length:r}),this}registerUniforms(e){return this.uniforms=this.uniforms.concat(e),this}uniformDeclaration(){if(this.uniforms.length===0)return"";let e=[];for(let{name:t,type:r,length:i}of this.uniforms)if(i&&i>4)r==="f16"?e.push(`@align(16) ${t}:array<mat2x4<${r}>, ${Math.ceil(i/8)}>`):e.push(`${t}:array<vec4<${r}>, ${Math.ceil(i/4)}>`);else{let a=i==null||i===1?r:`vec${i}<${r}>`;e.push(`${t}:${a}`)}return`
      struct Uniforms { ${e.join(", ")} };
      @group(0) @binding(${this.variableIndex}) var<uniform> uniforms: Uniforms;`}get additionalImplementations(){return this.uniformDeclaration()+this.variables.map(e=>e.impl()).join(`
`)+this.internalVariables.map(e=>e.impl()).join(`
`)}get variablesInfo(){if(this.uniforms.length===0)return;let e=t=>[12,10,1,6][["u32","f16","f32","i32"].indexOf(t)];return this.uniforms.map(t=>{var r;return[e(t.type),(r=t.length)!=null?r:1]})}},_p=(e,t)=>new zo(e,t)}),Co,Di,Ao,Oo,Ro,Bo,Pe,bp,$p,_t=U(()=>{te(),ie(),xe(),ae(),Co=(e,t)=>{if(!e||e.length!==1)throw new Error("Transpose requires 1 input.");if(t.length!==0&&t.length!==e[0].dims.length)throw new Error(`perm size ${t.length} does not match input rank ${e[0].dims.length}`)},Di=(e,t)=>t.length!==0?t:[...new Array(e).keys()].reverse(),Ao=(e,t)=>R.sortBasedOnPerm(e,Di(e.length,t)),Oo=(e,t,r,i)=>{let a=`fn perm(i: ${i.type.indices}) -> ${r.type.indices} {
    var a: ${r.type.indices};`;for(let s=0;s<t;++s)a+=`a[${e[s]}]=i[${s}];`;return a+="return a;}"},Ro=(e,t)=>{let r=[],i=[];for(let a=0;a<e.length;++a)e[a]!==1&&r.push(e[a]),e[t[a]]!==1&&i.push(t[a]);return{newShape:r,newPerm:i}},Bo=(e,t)=>{let r=0;for(let i=0;i<e.length;++i)if(t[e[i]]!==1){if(e[i]<r)return!1;r=e[i]}return!0},Pe=(e,t)=>{let r=e.dataType,i=e.dims.length,a=Di(i,t),s=Ao(e.dims,a),n=e.dims,u=s,l=i<2||Bo(a,e.dims),p;if(l)return p=_=>{let b=N("input",r,n,4),S=Q("output",r,u,4);return`
  ${_.registerUniform("output_size","u32").declareVariables(b,S)}
  ${_.mainStart()}
    ${_.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.output_size")}
    output[global_idx] = input[global_idx];
  }`},{name:"TransposeCopy",shaderCache:{inputDependencies:["type"]},getRunData:()=>{let _=R.size(s);return{outputs:[{dims:s,dataType:e.dataType}],dispatchGroup:{x:Math.ceil(_/64/4)},programUniforms:[{type:12,data:Math.ceil(_/4)}]}},getShaderSource:p};let{newShape:h,newPerm:m}=Ro(e.dims,a),g=R.areEqual(m,[2,3,1]),y=R.areEqual(m,[3,1,2]);if(h.length===2||g||y){n=g?[h[0],h[1]*h[2]]:y?[h[0]*h[1],h[2]]:h,u=[n[1],n[0]];let _=16;return p=b=>{let S=N("a",r,n.length),v=Q("output",r,u.length);return`
  ${b.registerUniform("output_size","u32").declareVariables(S,v)}
  var<workgroup> tile : array<array<${v.type.value}, ${_+1}>, ${_}>;
  ${b.mainStart([_,_,1])}
    let stride = (uniforms.output_shape[1] - 1) / ${_} + 1;
    let workgroup_id_x = workgroup_index % stride;
    let workgroup_id_y = workgroup_index / stride;
    let input_col = workgroup_id_y * ${_}u + local_id.x;
    let input_row = workgroup_id_x * ${_}u + local_id.y;
    if (input_row < uniforms.a_shape[0] && input_col < uniforms.a_shape[1]) {
      tile[local_id.y][local_id.x] = ${S.getByIndices(`${S.type.indices}(input_row, input_col)`)};
    }
    workgroupBarrier();

    let output_col = workgroup_id_x * ${_}u + local_id.x;
    let output_row = workgroup_id_y * ${_}u + local_id.y;
    if (output_row < uniforms.output_shape[0] && output_col < uniforms.output_shape[1]) {
      ${v.setByIndices(`${v.type.indices}(output_row, output_col)`,"tile[local_id.x][local_id.y]")}
    }
  }`},{name:"TransposeShared",shaderCache:{inputDependencies:["type"]},getRunData:()=>{let b=R.size(s);return{outputs:[{dims:s,dataType:e.dataType}],dispatchGroup:{x:Math.ceil(u[1]/_),y:Math.ceil(u[0]/_)},programUniforms:[{type:12,data:b},...ee(n,u)]}},getShaderSource:p}}return p=_=>{let b=N("a",r,n.length),S=Q("output",r,u.length);return`
  ${_.registerUniform("output_size","u32").declareVariables(b,S)}

  ${Oo(a,i,b,S)}

  ${_.mainStart()}
    ${_.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.output_size")}

    let indices = ${S.offsetToIndices("global_idx")};
    let aIndices = perm(indices);

    ${S.setByOffset("global_idx",b.getByIndices("aIndices"))}
  }`},{name:"Transpose",shaderCache:{hint:`${t}`,inputDependencies:["rank"]},getRunData:()=>{let _=R.size(s);return{outputs:[{dims:s,dataType:e.dataType}],dispatchGroup:{x:Math.ceil(_/64)},programUniforms:[{type:12,data:_},...ee(n,u)]}},getShaderSource:p}},bp=(e,t)=>{Co(e.inputs,t.perm),e.compute(Pe(e.inputs[0],t.perm))},$p=e=>fe({perm:e.perm})}),No,Mo,Do,Uo,Po,qo,Lo,Wo,Vo,Go,Ge,wp,vp,xp,Sp,kp,Tp,Ip,Ep,zp,Cp,e0=U(()=>{te(),ie(),ae(),Va(),_t(),No={max:"select(bestValue, candidate, candidate > bestValue)",min:"select(bestValue, candidate, candidate < bestValue)",mean:"bestValue + candidate",sum:"bestValue + candidate",prod:"bestValue * candidate",sumSquare:"bestValue + candidate * candidate",logSumExp:"bestValue + exp(candidate)",l1:"bestValue + abs(candidate)",l2:"bestValue + candidate * candidate",logSum:"bestValue + candidate"},Mo={max:"select(bestValue, candidate, candidate > bestValue)",min:"select(bestValue, candidate, candidate < bestValue)",mean:"bestValue + candidate",sum:"bestValue + candidate",prod:"bestValue * candidate",sumSquare:"bestValue + candidate",logSumExp:"bestValue + candidate",l1:"bestValue + candidate",l2:"bestValue + candidate",logSum:"bestValue + candidate"},Do={max:"_A[offset]",min:"_A[offset]",mean:"0",sum:"0",prod:"1",sumSquare:"0",logSumExp:"0",l1:"0",l2:"0",logSum:"0"},Uo={max:"bestValue",min:"bestValue",sum:"bestValue",prod:"bestValue",sumSquare:"bestValue",logSumExp:"log(bestValue)",l1:"bestValue",l2:"sqrt(bestValue)",logSum:"log(bestValue)"},Po=(e,t)=>{let r=[];for(let i=t-e;i<t;++i)r.push(i);return r},qo=(e,t)=>{let r=[],i=e.length;for(let s=0;s<i;s++)t.indexOf(s)===-1&&r.push(e[s]);let a=t.map(s=>e[s]);return[r,a]},Lo=(e,t)=>{let r=e.length+t.length,i=[],a=0;for(let s=0;s<r;s++)t.indexOf(s)===-1?i.push(e[a++]):i.push(1);return i},Wo=(e,t)=>{for(let r=0;r<e.length;++r)if(e[e.length-r-1]!==t-1-r)return!1;return!0},Vo=(e,t)=>{let r=[];if(!Wo(e,t)){for(let i=0;i<t;++i)e.indexOf(i)===-1&&r.push(i);e.forEach(i=>r.push(i))}return r},Go=(e,t,r,i,a,s,n)=>{let u=r[0].dims,l=R.size(s),p=R.size(n),h=N("_A",r[0].dataType,u),m=Q("output",a,s),g=64;l===1&&(g=256);let y=`
          var<workgroup> aBestValues : array<f32, ${g}>;
       `,_=b=>`
        ${b.registerUniform("reduceSize","u32").declareVariables(h,m)}
        ${y}
        fn DIV_CEIL(a : u32, b : u32) -> u32 {
          return ((a - 1u) / b + 1u);
         }
         ${b.mainStart(g)}

          let outputIndex = global_idx / ${g};
          let offset = outputIndex * uniforms.reduceSize;

          var bestValue = f32(${Do[i]});
          let Length = uniforms.reduceSize;
          for (var k = local_idx; k < Length; k = k + ${g}) {
           let candidate = f32(${h.getByOffset("offset + k")});
           bestValue = ${No[i]};
          }
          aBestValues[local_idx] = bestValue;
          workgroupBarrier();

         var reduceSize = min(Length, ${g}u);
         for (var currentSize = reduceSize / 2u; reduceSize > 1u;
             currentSize = reduceSize / 2u) {
           let interval = DIV_CEIL(reduceSize, 2u);
           if (local_idx < currentSize) {
            let candidate = aBestValues[local_idx + interval];
            bestValue = ${Mo[i]};
            aBestValues[local_idx] = bestValue;
           }
           reduceSize = interval;
           workgroupBarrier();
         }

         if (local_idx == 0u) {
          ${m.setByOffset("outputIndex",`${i==="mean"?`${m.type.storage}(bestValue / f32(uniforms.reduceSize))`:`${m.type.storage}(${Uo[i]})`}`)};
         }
        }`;return{name:e,shaderCache:{hint:`${t};${g}`,inputDependencies:["type"]},getShaderSource:_,getRunData:()=>({outputs:[{dims:s,dataType:a}],dispatchGroup:{x:l},programUniforms:[{type:12,data:p}]})}},Ge=(e,t,r,i)=>{let a=e.inputs.length===1?r:ba(e.inputs,r),s=a.axes;s.length===0&&!a.noopWithEmptyAxes&&(s=e.inputs[0].dims.map((y,_)=>_));let n=R.normalizeAxes(s,e.inputs[0].dims.length),u=n,l=e.inputs[0],p=Vo(u,e.inputs[0].dims.length);p.length>0&&(l=e.compute(Pe(e.inputs[0],p),{inputs:[0],outputs:[-1]})[0],u=Po(u.length,l.dims.length));let[h,m]=qo(l.dims,u),g=h;a.keepDims&&(g=Lo(h,n)),e.compute(Go(t,a.cacheKey,[l],i,e.inputs[0].dataType,g,m),{inputs:[l]})},wp=(e,t)=>{Ge(e,"ReduceMeanShared",t,"mean")},vp=(e,t)=>{Ge(e,"ReduceL1Shared",t,"l1")},xp=(e,t)=>{Ge(e,"ReduceL2Shared",t,"l2")},Sp=(e,t)=>{Ge(e,"ReduceLogSumExpShared",t,"logSumExp")},kp=(e,t)=>{Ge(e,"ReduceMaxShared",t,"max")},Tp=(e,t)=>{Ge(e,"ReduceMinShared",t,"min")},Ip=(e,t)=>{Ge(e,"ReduceProdShared",t,"prod")},Ep=(e,t)=>{Ge(e,"ReduceSumShared",t,"sum")},zp=(e,t)=>{Ge(e,"ReduceSumSquareShared",t,"sumSquare")},Cp=(e,t)=>{Ge(e,"ReduceLogSumShared",t,"logSum")}}),He,Ho,Hr,ba,Fe,Fo,jo,Ko,Zo,Xo,Qo,Yo,Jo,eu,tu,je,Ap,Op,Rp,Bp,Np,Mp,Dp,Up,Pp,qp,Va=U(()=>{te(),ie(),xe(),ae(),e0(),He=e=>{if(!e||e.length===0||e.length>2)throw new Error("Reduce op requires 1 or 2 inputs.");if(e.length===2&&e[1].dims.length!==1)throw new Error("Invalid axes input dims.")},Ho=e=>["","",`var value = ${e.getByIndices("input_indices")};`,""],Hr=(e,t,r,i,a,s,n=!1,u=!1)=>{let l=[],p=r[0].dims,h=p.length,m=R.normalizeAxes(a,h),g=!u&&m.length===0;p.forEach((b,S)=>{g||m.indexOf(S)>=0?n&&l.push(1):l.push(b)});let y=l.length,_=R.size(l);return{name:e,shaderCache:t,getShaderSource:b=>{let S=[],v=N("_A",r[0].dataType,h),w=Q("output",s,y),I=i(v,w,m),k=I[2];for(let E=0,A=0;E<h;E++)g||m.indexOf(E)>=0?(n&&A++,k=`for(var j${E}: u32 = 0; j${E} < ${p[E]}; j${E}++) {
                  ${I[2].includes("last_index")?`let last_index = j${E};`:""}
                  ${v.indicesSet("input_indices",E,`j${E}`)}
                  ${k}
                }`):(S.push(`${v.indicesSet("input_indices",E,w.indicesGet("output_indices",A))};`),A++);return`

        ${b.registerUniform("output_size","u32").declareVariables(v,w)}

        ${b.mainStart()}
          ${b.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.output_size")}
          var input_indices: ${v.type.indices};
          let output_indices = ${w.offsetToIndices("global_idx")};

          ${S.join(`
`)}
          ${I[0]}       // init ops for reduce max/min
          ${I[1]}
          ${k}
          ${I[3]}
          ${I.length===4?w.setByOffset("global_idx","value"):I.slice(4).join(`
`)}
        }`},getRunData:()=>({outputs:[{dims:l,dataType:s}],dispatchGroup:{x:Math.ceil(_/64)},programUniforms:[{type:12,data:_},...ee(p,l)]})}},ba=(e,t)=>{let r=[];return e[1].dims[0]>0&&e[1].getBigInt64Array().forEach(i=>r.push(Number(i))),fe({axes:r,keepDims:t.keepDims,noopWithEmptyAxes:t.noopWithEmptyAxes})},Fe=(e,t,r,i)=>{let a=e.inputs,s=a.length===1?r:ba(a,r);e.compute(Hr(t,{hint:s.cacheKey,inputDependencies:["rank"]},[a[0]],s.noopWithEmptyAxes&&s.axes.length===0?Ho:i,s.axes,a[0].dataType,s.keepDims,s.noopWithEmptyAxes),{inputs:[0]})},Fo=(e,t)=>{He(e.inputs),Fe(e,"ReduceLogSum",t,(r,i)=>[`var value = ${i.type.storage}(0);`,"",`value += ${r.getByIndices("input_indices")};`,"value = log(value);"])},jo=(e,t)=>{He(e.inputs),Fe(e,"ReduceL1",t,(r,i)=>[`var value = ${i.type.storage}(0);`,"",`value += abs(${r.getByIndices("input_indices")});`,""])},Ko=(e,t)=>{He(e.inputs),Fe(e,"ReduceL2",t,(r,i)=>[`var t = ${i.type.value}(0); var value = ${i.type.value}(0);`,"",`t = ${r.getByIndices("input_indices")}; value += (t * t);`,"value = sqrt(value);"])},Zo=(e,t)=>{He(e.inputs),Fe(e,"ReduceLogSumExp",t,(r,i)=>[`var value = ${i.type.storage}(0);`,"",`value += exp(${r.getByIndices("input_indices")});`,"value = log(value);"])},Xo=(e,t)=>{He(e.inputs),Fe(e,"ReduceMax",t,(r,i,a)=>{let s=[];for(let n=0;n<r.rank;n++)(a.indexOf(n)>=0||a.length===0)&&s.push(r.indicesSet("input_indices",n,0));return[`${s.join(`
`)}`,`var value = ${r.getByIndices("input_indices")};`,`value = max(value, ${r.getByIndices("input_indices")});`,""]})},Qo=(e,t)=>{He(e.inputs),Fe(e,"ReduceMean",t,(r,i,a)=>{let s=1;for(let n=0;n<r.rank;n++)(a.indexOf(n)>=0||a.length===0)&&(s*=e.inputs[0].dims[n]);return["var sum = f32(0);","",`sum += f32(${r.getByIndices("input_indices")});`,`let value = ${i.type.value}(sum / ${s});`]})},Yo=(e,t)=>{He(e.inputs),Fe(e,"ReduceMin",t,(r,i,a)=>{let s=[];for(let n=0;n<r.rank;n++)(a.indexOf(n)>=0||a.length===0)&&s.push(`input_indices[${n}] = 0;`);return[`${s.join(`
`)}`,`var value = ${r.getByIndices("input_indices")};`,`value = min(value, ${r.getByIndices("input_indices")});`,""]})},Jo=(e,t)=>{He(e.inputs),Fe(e,"ReduceProd",t,(r,i)=>[`var value = ${i.type.storage}(1);`,"",`value *= ${r.getByIndices("input_indices")};`,""])},eu=(e,t)=>{He(e.inputs),Fe(e,"ReduceSum",t,(r,i)=>[`var value = ${i.type.storage}(0);`,"",`value += ${r.getByIndices("input_indices")};`,""])},tu=(e,t)=>{He(e.inputs),Fe(e,"ReduceSumSquare",t,(r,i)=>[`var t = ${i.type.value}(0); var value = ${i.type.value}(0);`,"",`t = ${r.getByIndices("input_indices")}; value += t * t;`,""])},je=(e,t,r)=>{if(t.length===0)return r;let i=1,a=1;for(let s=0;s<t.length;s++)t.indexOf(s)===-1?i*=e[s]:a*=e[s];return a<32&&i>1024},Ap=(e,t)=>{je(e.inputs[0].dims,t.axes,t.noopWithEmptyAxes)?Qo(e,t):wp(e,t)},Op=(e,t)=>{je(e.inputs[0].dims,t.axes,t.noopWithEmptyAxes)?jo(e,t):vp(e,t)},Rp=(e,t)=>{je(e.inputs[0].dims,t.axes,t.noopWithEmptyAxes)?Ko(e,t):xp(e,t)},Bp=(e,t)=>{je(e.inputs[0].dims,t.axes,t.noopWithEmptyAxes)?Zo(e,t):Sp(e,t)},Np=(e,t)=>{je(e.inputs[0].dims,t.axes,t.noopWithEmptyAxes)?Xo(e,t):kp(e,t)},Mp=(e,t)=>{je(e.inputs[0].dims,t.axes,t.noopWithEmptyAxes)?Yo(e,t):Tp(e,t)},Dp=(e,t)=>{je(e.inputs[0].dims,t.axes,t.noopWithEmptyAxes)?Jo(e,t):Ip(e,t)},Up=(e,t)=>{je(e.inputs[0].dims,t.axes,t.noopWithEmptyAxes)?eu(e,t):Ep(e,t)},Pp=(e,t)=>{je(e.inputs[0].dims,t.axes,t.noopWithEmptyAxes)?tu(e,t):zp(e,t)},qp=(e,t)=>{je(e.inputs[0].dims,t.axes,t.noopWithEmptyAxes)?Fo(e,t):Cp(e,t)}}),Ui,Lp,Wp,$a,t0=U(()=>{te(),xe(),Va(),Ui=e=>{if(!e||e.length===0||e.length>2)throw new Error("ArgMinMaxOp op requires 1 or 2 inputs.");if(e[0].dataType!==1)throw new Error("Invalid input type.")},Lp=(e,t)=>{Ui(e.inputs);let r=(i,a,s)=>{let n=[];for(let u=0;u<i.rank;u++)(s.indexOf(u)>=0||s.length===0)&&n.push(`input_indices[${u}] = 0;`);return[`${n.join(`
`)}`,`var value = ${i.getByIndices("input_indices")};
var best_index : i32 = 0;`,`if (${i.getByIndices("input_indices")} ${t.selectLastIndex>0?"<=":"<"} value) {
         value = ${i.getByIndices("input_indices")};
         best_index = i32(last_index);
       }`,"",a.setByOffset("global_idx","best_index")]};e.compute(Hr("ArgMin",{hint:t.cacheKey,inputDependencies:["rank"]},[e.inputs[0]],r,[t.axis],7,t.keepDims),{inputs:[0]})},Wp=(e,t)=>{Ui(e.inputs);let r=(i,a,s)=>{let n=[];for(let u=0;u<i.rank;u++)(s.indexOf(u)>=0||s.length===0)&&n.push(`input_indices[${u}] = 0;`);return[`${n.join(`
`)}`,`var value = ${i.getByIndices("input_indices")};
var best_index : i32 = 0;`,`if (${i.getByIndices("input_indices")} ${t.selectLastIndex>0?">=":">"} value) {
         value = ${i.getByIndices("input_indices")};
         best_index = i32(last_index);
       }`,"",a.setByOffset("global_idx","best_index")]};e.compute(Hr("argMax",{hint:t.cacheKey,inputDependencies:["rank"]},[e.inputs[0]],r,[t.axis],7,t.keepDims),{inputs:[0]})},$a=e=>fe(e)}),ru,Or,iu,au,nu,cr,su,Vp,Ga=U(()=>{te(),ie(),La(),ae(),ru=(e,t)=>{let r=e[0],i=e[1],a=e[2],s=e[3],n=e[4],u=e[5];if(n&&u)throw new Error("Attention cannot have both past and attention_bias");if(r.dims.length!==3)throw new Error('Input "input" must have 3 dimensions');let l=r.dims[0],p=r.dims[1],h=r.dims[2];if(a.dims.length!==1)throw new Error('Input "bias" is expected to have 1 dimensions');if(i.dims.length!==2)throw new Error('Input "weights" is expected to have 2 dimensions');if(i.dims[0]!==h)throw new Error("Input 1 dimension 0 should have same length as dimension 2 of input 0");if(a.dims[0]!==i.dims[1])throw new Error('Input "bias" dimension 0 should have same length as dimension 1 of input "weights"');let m=a.dims[0]/3,g=m,y=g;if(t.qkvHiddenSizes.length>0){if(t.qkvHiddenSizes.length!==3)throw new Error("qkv_hidden_sizes attribute should have 3 elements");for(let I of t.qkvHiddenSizes)if(I%t.numHeads!==0)throw new Error("qkv_hidden_sizes should be divisible by num_heads");m=t.qkvHiddenSizes[0],g=t.qkvHiddenSizes[1],y=t.qkvHiddenSizes[2]}let _=p;if(m!==g)throw new Error("qkv_hidden_sizes first element should be same as the second");if(a.dims[0]!==m+g+y)throw new Error('Input "bias" dimension 0 should have same length as sum of Q/K/V hidden sizes');let b=0;if(n){if(g!==y)throw new Error('Input "past" expect k_hidden_size == v_hidden_size');if(n.dims.length!==5)throw new Error('Input "past" must have 5 dimensions');if(n.dims[0]!==2)throw new Error('Input "past" first dimension must be 2');if(n.dims[1]!==l)throw new Error('Input "past" second dimension must be batch_size');if(n.dims[2]!==t.numHeads)throw new Error('Input "past" third dimension must be num_heads');if(n.dims[4]!==g/t.numHeads)throw new Error('Input "past" fifth dimension must be k_hidden_size / num_heads');t.pastPresentShareBuffer||(b=n.dims[3])}let S=_+b,v=-1,w=0;if(s)throw new Error("Mask not supported");if(n)throw new Error("past is not supported");if(u){if(u.dims.length!==4)throw new Error('Input "attention_bias" must have 4 dimensions');if(u.dims[0]!==l||u.dims[1]!==t.numHeads||u.dims[2]!==p||u.dims[3]!==S)throw new Error('Expect "attention_bias" shape (batch_size, num_heads, sequence_length, total_sequence_length)')}return{batchSize:l,sequenceLength:p,pastSequenceLength:b,kvSequenceLength:_,totalSequenceLength:S,maxSequenceLength:v,inputHiddenSize:h,hiddenSize:m,vHiddenSize:y,headSize:Math.floor(m/t.numHeads),vHeadSize:Math.floor(y/t.numHeads),numHeads:t.numHeads,isUnidirectional:!1,pastPresentShareBuffer:!1,maskFilterValue:t.maskFilterValue,maskType:w,scale:t.scale,broadcastResPosBias:!1,passPastInKv:!1,qkvFormat:1}},Or=(e,t,r)=>t&&e?`
      let total_sequence_length_input = u32(${t.getByOffset("0")});
      let present_sequence_length = max(total_sequence_length_input, uniforms.past_sequence_length);
      let is_subsequent_prompt: bool = sequence_length > 1 && sequence_length != total_sequence_length_input;
      let is_first_prompt: bool = is_subsequent_prompt == false && sequence_length == total_sequence_length_input;
      total_sequence_length = u32(${e==null?void 0:e.getByOffset("batchIdx")}) + 1;
      var past_sequence_length: u32 = 0;
      if (is_first_prompt == false) {
        past_sequence_length = total_sequence_length - sequence_length;
      }
       `:`
    ${r?"let past_sequence_length = uniforms.past_sequence_length":""};
    let present_sequence_length = total_sequence_length;
    `,iu=(e,t,r,i,a,s,n,u)=>{let l=ve(n?1:s),p=64,h=s/l;h<p&&(p=32);let m=Math.ceil(s/l/p),g=[{type:12,data:t},{type:12,data:r},{type:12,data:i},{type:12,data:a},{type:12,data:h},{type:12,data:m}],y=Te(e.dataType,l),_=ze(1,l),b=["type"];n&&b.push("type"),u&&b.push("type");let S=v=>{let w=Q("x",e.dataType,e.dims,l),I=[w],k=n?N("seq_lens",n.dataType,n.dims):void 0;k&&I.push(k);let E=u?N("total_sequence_length_input",u.dataType,u.dims):void 0;E&&I.push(E);let A=ze(e.dataType),C=[{name:"batch_size",type:"u32"},{name:"num_heads",type:"u32"},{name:"past_sequence_length",type:"u32"},{name:"sequence_length",type:"u32"},{name:"total_sequence_length",type:"u32"},{name:"elements_per_thread",type:"u32"}];return`
  var<workgroup> thread_max: array<f32, ${p}>;
  var<workgroup> thread_sum: array<f32, ${p}>;
  ${v.registerUniforms(C).declareVariables(...I)}
  ${v.mainStart([p,1,1])}
    let batchIdx = workgroup_id.z / uniforms.num_heads;
    let headIdx = workgroup_id.z % uniforms.num_heads;
    let sequence_length = uniforms.sequence_length;
    var total_sequence_length = uniforms.total_sequence_length;
    ${Or(k,E,!1)}
    let local_offset = local_idx * uniforms.elements_per_thread;
    let offset = (global_idx / ${p}) * uniforms.total_sequence_length + local_offset;
    let seq_causal_length = ${n?"u32(past_sequence_length + workgroup_id.y + 1)":"total_sequence_length"};
    var thread_max_vector = ${_}(-3.4028234663852886e+38f);
    for (var i: u32 = 0; i < uniforms.elements_per_thread && i + local_offset < seq_causal_length; i++) {
      thread_max_vector = max(${_}(x[offset + i]), thread_max_vector);
    }
    thread_max[local_idx] = ${(()=>{switch(l){case 1:return"thread_max_vector";case 2:return"max(thread_max_vector.x, thread_max_vector.y)";case 4:return"max(max(thread_max_vector.x, thread_max_vector.y), max(thread_max_vector.z, thread_max_vector.w))";default:throw new Error(`Unsupported components: ${l}`)}})()};
    workgroupBarrier();

    var max_value =  f32(-3.4028234663852886e+38f);
    for (var i = 0u; i < ${p}; i++) {
      max_value = max(thread_max[i], max_value);
    }

    var sum_vector = ${_}(0);
    for (var i: u32 = 0; i < uniforms.elements_per_thread && i + local_offset < seq_causal_length; i++) {
      sum_vector += exp(${_}(x[offset + i]) - max_value);
    }
    thread_sum[local_idx] = ${(()=>{switch(l){case 1:return"sum_vector";case 2:return"sum_vector.x + sum_vector.y";case 4:return"sum_vector.x + sum_vector.y + sum_vector.z + sum_vector.w";default:throw new Error(`Unsupported components: ${l}`)}})()};
    workgroupBarrier();

    var sum: f32 = 0;
    for (var i = 0u; i < ${p}; i++) {
      sum += thread_sum[i];
    }

    if (sum == 0) {
      for (var i: u32 = 0; i < uniforms.elements_per_thread && i + local_offset < seq_causal_length; i++) {
        x[offset + i] = ${w.type.value}(${A}(1.0) / ${A}(seq_causal_length));
      }
    } else {
      for (var i: u32 = 0; i < uniforms.elements_per_thread && i + local_offset < seq_causal_length; i++) {
        var f32input = ${_}(x[offset + i]);
        x[offset + i] = ${w.type.value}(exp(f32input - max_value) / sum);
      }
    }
      ${n?`
        for (var total_seq_id: u32 = seq_causal_length; total_seq_id + local_offset < uniforms.total_sequence_length; total_seq_id++) {
          x[offset + total_seq_id] = ${w.type.value}(${A}(0));
        }`:""};
  }`};return{name:"AttentionProbsSoftmax",shaderCache:{hint:`${p};${y};${l}`,inputDependencies:b},getShaderSource:S,getRunData:()=>({outputs:[],dispatchGroup:{x:1,y:a,z:t*r},programUniforms:g})}},au=(e,t,r,i,a,s,n,u,l)=>{let p=n+s.kvSequenceLength,h=[s.batchSize,s.numHeads,s.sequenceLength,p],m=e>1&&i,g=s.kvNumHeads?s.kvNumHeads:s.numHeads,y=m?[s.batchSize,g,p,s.headSize]:void 0,_=s.nReps?s.nReps:1,b=s.scale===0?1/Math.sqrt(s.headSize):s.scale,S=ve(s.headSize),v=s.headSize/S,w=12,I={x:Math.ceil(p/w),y:Math.ceil(s.sequenceLength/w),z:s.batchSize*s.numHeads},k=[{type:12,data:s.sequenceLength},{type:12,data:v},{type:12,data:p},{type:12,data:s.numHeads},{type:12,data:s.headSize},{type:1,data:b},{type:12,data:n},{type:12,data:s.kvSequenceLength},{type:12,data:_}],E=m&&i&&R.size(i.dims)>0,A=["type","type"];E&&A.push("type"),a&&A.push("type"),u&&A.push("type"),l&&A.push("type");let C=[{dims:h,dataType:t.dataType,gpuDataType:0}];m&&C.push({dims:y,dataType:t.dataType,gpuDataType:0});let x=D=>{let M=N("q",t.dataType,t.dims,S),P=N("key",r.dataType,r.dims,S),K=[M,P];if(E){let V=N("past_key",i.dataType,i.dims,S);K.push(V)}a&&K.push(N("attention_bias",a.dataType,a.dims));let Z=u?N("seq_lens",u.dataType,u.dims):void 0;Z&&K.push(Z);let O=l?N("total_sequence_length_input",l.dataType,l.dims):void 0;O&&K.push(O);let G=Q("output",t.dataType,h),F=[G];m&&F.push(Q("present_key",t.dataType,y,S));let Y=ze(1,S),he=[{name:"M",type:"u32"},{name:"K",type:"u32"},{name:"N",type:"u32"},{name:"num_heads",type:"u32"},{name:"head_size",type:"u32"},{name:"alpha",type:"f32"},{name:"past_sequence_length",type:"u32"},{name:"kv_sequence_length",type:"u32"},{name:"n_reps",type:"u32"}];return`
  const TILE_SIZE = ${w}u;

  var<workgroup> tileQ: array<${M.type.storage}, ${w*w}>;
  var<workgroup> tileK: array<${M.type.storage}, ${w*w}>;
  ${D.registerUniforms(he).declareVariables(...K,...F)}
  ${D.mainStart([w,w,1])}
    // x holds the N and y holds the M
    let headIdx = workgroup_id.z % uniforms.num_heads;
    let kvHeadIdx = ${_===1?"headIdx":"headIdx / uniforms.n_reps"};
    let kv_num_heads = ${_===1?"uniforms.num_heads":"uniforms.num_heads / uniforms.n_reps"};
    let batchIdx = workgroup_id.z / uniforms.num_heads;
    let m = workgroup_id.y * TILE_SIZE;
    let n = workgroup_id.x * TILE_SIZE;
    let sequence_length = uniforms.M;
    var total_sequence_length = uniforms.N;
    ${Or(Z,O,!0)}
    let absKvHeadIdx = batchIdx * kv_num_heads + kvHeadIdx;
    let qOffset = workgroup_id.z * uniforms.M * uniforms.K + m * uniforms.K;
    ${E&&m?"let pastKeyOffset = absKvHeadIdx * uniforms.past_sequence_length * uniforms.K;":""};
    let kOffset = absKvHeadIdx * uniforms.kv_sequence_length * uniforms.K;
    ${m?"let presentKeyOffset = absKvHeadIdx * uniforms.N * uniforms.K;":""}
    var value = ${Y}(0);
    for (var w: u32 = 0u; w < uniforms.K; w += TILE_SIZE) {
      if (global_id.y < uniforms.M && w + local_id.x < uniforms.K) {
        tileQ[TILE_SIZE * local_id.y + local_id.x] = q[qOffset + local_id.y * uniforms.K + w + local_id.x];
      }
      if (n + local_id.y < uniforms.N && w + local_id.x < uniforms.K) {
        var idx = TILE_SIZE * local_id.y + local_id.x;
      ${E&&m?`
              if (n + local_id.y < past_sequence_length) {
                tileK[idx] = past_key[pastKeyOffset + (n + local_id.y) * uniforms.K + w + local_id.x];
              } else if (n + local_id.y - past_sequence_length < uniforms.kv_sequence_length) {
                tileK[idx] = key[kOffset + (n + local_id.y - past_sequence_length) * uniforms.K + w + local_id.x];
              }`:`
          if (n + local_id.y < uniforms.kv_sequence_length) {
            tileK[idx] = key[kOffset + (n + local_id.y) * uniforms.K + w + local_id.x];
          }`}
      ${m?`if (n + local_id.y < present_sequence_length) {
        present_key[presentKeyOffset + (n + local_id.y) * uniforms.K + w + local_id.x] = tileK[idx];
      }`:""}
      }
      workgroupBarrier();

      for (var k: u32 = 0u; k < TILE_SIZE && w+k < uniforms.K; k++) {
          value += ${Y}(tileQ[TILE_SIZE * local_id.y + k] * tileK[TILE_SIZE * local_id.x + k]);
      }

      workgroupBarrier();
    }

    if (global_id.y < uniforms.M && global_id.x < total_sequence_length) {
      let headOffset = workgroup_id.z * uniforms.M * uniforms.N;
      let outputIdx = headOffset + global_id.y * uniforms.N + global_id.x;
      var sum: f32 = ${(()=>{switch(S){case 1:return"value";case 2:return"value.x + value.y";case 4:return"value.x + value.y + value.z + value.w";default:throw new Error(`Unsupported components: ${S}`)}})()};
        output[outputIdx] = ${G.type.value} (sum * uniforms.alpha) + ${a?"attention_bias[outputIdx]":"0.0"};
    }
  }`};return{name:"AttentionProbs",shaderCache:{hint:`${S};${a!==void 0};${i!==void 0};${e}`,inputDependencies:A},getRunData:()=>({outputs:C,dispatchGroup:I,programUniforms:k}),getShaderSource:x}},nu=(e,t,r,i,a,s,n=void 0,u=void 0)=>{let l=s+a.kvSequenceLength,p=a.nReps?a.nReps:1,h=a.vHiddenSize*p,m=e>1&&i,g=a.kvNumHeads?a.kvNumHeads:a.numHeads,y=m?[a.batchSize,g,l,a.headSize]:void 0,_=[a.batchSize,a.sequenceLength,h],b=12,S={x:Math.ceil(a.vHeadSize/b),y:Math.ceil(a.sequenceLength/b),z:a.batchSize*a.numHeads},v=[{type:12,data:a.sequenceLength},{type:12,data:l},{type:12,data:a.vHeadSize},{type:12,data:a.numHeads},{type:12,data:a.headSize},{type:12,data:h},{type:12,data:s},{type:12,data:a.kvSequenceLength},{type:12,data:p}],w=m&&i&&R.size(i.dims)>0,I=["type","type"];w&&I.push("type"),n&&I.push("type"),u&&I.push("type");let k=[{dims:_,dataType:t.dataType,gpuDataType:0}];m&&k.push({dims:y,dataType:t.dataType,gpuDataType:0});let E=A=>{let C=N("probs",t.dataType,t.dims),x=N("v",r.dataType,r.dims),D=[C,x];w&&D.push(N("past_value",i.dataType,i.dims));let M=n?N("seq_lens",n.dataType,n.dims):void 0;n&&D.push(M);let P=u?N("total_sequence_length_input",u.dataType,u.dims):void 0;u&&D.push(P);let K=[Q("output",t.dataType,_)];m&&K.push(Q("present_value",t.dataType,y));let Z=[{name:"M",type:"u32"},{name:"K",type:"u32"},{name:"N",type:"u32"},{name:"num_heads",type:"u32"},{name:"head_size",type:"u32"},{name:"v_hidden_size",type:"u32"},{name:"past_sequence_length",type:"u32"},{name:"kv_sequence_length",type:"u32"},{name:"n_reps",type:"u32"}];return`
  const TILE_SIZE = ${b}u;
  var<workgroup> tileQ: array<${C.type.value}, ${b*b}>;
  var<workgroup> tileV: array<${C.type.value}, ${b*b}>;
  ${A.registerUniforms(Z).declareVariables(...D,...K)}
  ${A.mainStart([b,b,1])}
   let headIdx = workgroup_id.z % uniforms.num_heads;
   let batchIdx = workgroup_id.z / uniforms.num_heads;
   let kvHeadIdx = ${p===1?"headIdx":"headIdx / uniforms.n_reps"};
   let kv_num_heads = ${p===1?"uniforms.num_heads":"uniforms.num_heads / uniforms.n_reps"};
   let m = global_id.y;
   let n = global_id.x;
   let sequence_length = uniforms.M;
   var total_sequence_length = uniforms.K;
   ${Or(M,P,!0)}
   let offsetA = workgroup_id.z * uniforms.M * uniforms.K + m * uniforms.K;
   let absKvHeadIdx = batchIdx * kv_num_heads + kvHeadIdx; // kvHeadIdx is relative to the batch
   ${w&&m?"let pastValueOffset = absKvHeadIdx * uniforms.N * uniforms.past_sequence_length + n;":""};
   let vOffset = absKvHeadIdx * uniforms.N * uniforms.kv_sequence_length + n;
   ${m?"let presentValueOffset = absKvHeadIdx * uniforms.N * uniforms.K + n;":""}
   var value = ${C.type.storage}(0);
   for (var w: u32 = 0u; w < uniforms.K; w += TILE_SIZE) {
      if (m < uniforms.M && w + local_id.x < uniforms.K) {
        tileQ[TILE_SIZE * local_id.y + local_id.x] = probs[offsetA + w + local_id.x];
      }
      if (n < uniforms.N && w + local_id.y < uniforms.K) {
        var idx = TILE_SIZE * local_id.y + local_id.x;
        ${w&&m?`
        if (w + local_id.y < past_sequence_length) {
          tileV[idx] = past_value[pastValueOffset + (w + local_id.y) * uniforms.N];
        } else if (w + local_id.y - past_sequence_length < uniforms.kv_sequence_length) {
          tileV[idx] = v[vOffset + (w + local_id.y - past_sequence_length) * uniforms.N];
        }
      `:`
            if (w + local_id.y < uniforms.kv_sequence_length) {
              tileV[idx] = v[vOffset + (w + local_id.y) * uniforms.N];
            }`}
        ${m?`
            if (w + local_id.y < present_sequence_length) {
          present_value[presentValueOffset + (w + local_id.y) * uniforms.N] = tileV[idx];
        }`:""}
      }
     workgroupBarrier();
     for (var k: u32 = 0u; k < TILE_SIZE && w+k < total_sequence_length; k++) {
       value += tileQ[TILE_SIZE * local_id.y + k] * tileV[TILE_SIZE * k + local_id.x];
     }
     workgroupBarrier();
   }

   // we need to transpose output from BNSH_v to BSND_v
   if (m < uniforms.M && n < uniforms.N) {
     let outputIdx = batchIdx * uniforms.M * uniforms.v_hidden_size + m * uniforms.v_hidden_size
       + headIdx * uniforms.N + n;
     output[outputIdx] = value;
   }
  }`};return{name:"AttentionScore",shaderCache:{hint:`${i!==void 0};${e}`,inputDependencies:I},getRunData:()=>({outputs:k,dispatchGroup:S,programUniforms:v}),getShaderSource:E}},cr=(e,t,r,i,a,s,n,u,l,p,h=void 0,m=void 0)=>{let g=Math.min(e.outputCount,1+(n?1:0)+(u?1:0)),y=g>1?n:void 0,_=g>1?u:void 0,b=g>1?p.pastSequenceLength:0,S=b+p.kvSequenceLength,v=l&&R.size(l.dims)>0?l:void 0,w=[t,r];y&&R.size(y.dims)>0&&w.push(y),v&&w.push(v),h&&w.push(h),m&&w.push(m);let I=e.compute(au(g,t,r,y,v,p,b,h,m),{inputs:w,outputs:g>1?[-1,1]:[-1]})[0];e.compute(iu(I,p.batchSize,p.numHeads,b,p.sequenceLength,S,h,m),{inputs:h&&m?[I,h,m]:[I],outputs:[]});let k=[I,i];_&&R.size(_.dims)>0&&k.push(_),h&&k.push(h),m&&k.push(m),e.compute(nu(g,I,i,_,p,b,h,m),{inputs:k,outputs:g>1?[0,2]:[0]})},su=(e,t)=>{let r=[t.batchSize,t.numHeads,t.sequenceLength,t.headSize],i=t.sequenceLength,a=t.inputHiddenSize,s=t.headSize,n=12,u={x:Math.ceil(t.headSize/n),y:Math.ceil(t.sequenceLength/n),z:t.batchSize*t.numHeads},l=[e.inputs[0],e.inputs[1],e.inputs[2]],p=[{type:12,data:i},{type:12,data:a},{type:12,data:s},{type:12,data:t.numHeads},{type:12,data:t.headSize},{type:12,data:t.hiddenSize},{type:12,data:t.hiddenSize+t.hiddenSize+t.vHiddenSize}],h=m=>{let g=Q("output_q",l[0].dataType,r),y=Q("output_k",l[0].dataType,r),_=Q("output_v",l[0].dataType,r),b=N("input",l[0].dataType,l[0].dims),S=N("weight",l[1].dataType,l[1].dims),v=N("bias",l[2].dataType,l[2].dims),w=b.type.storage,I=[{name:"M",type:"u32"},{name:"K",type:"u32"},{name:"N",type:"u32"},{name:"num_heads",type:"u32"},{name:"head_size",type:"u32"},{name:"hidden_size",type:"u32"},{name:"ldb",type:"u32"}];return`
  const TILE_SIZE = ${n}u;
  var<workgroup> tileInput: array<${w}, ${n*n}>;
  var<workgroup> tileWeightQ: array<${w}, ${n*n}>;
  var<workgroup> tileWeightK: array<${w}, ${n*n}>;
  var<workgroup> tileWeightV: array<${w}, ${n*n}>;
  ${m.registerUniforms(I).declareVariables(b,S,v,g,y,_)}
  ${m.mainStart([n,n,1])}
    let batchIndex = workgroup_id.z / uniforms.num_heads;
    let headNumber = workgroup_id.z % uniforms.num_heads;
    let m = global_id.y;
    let n = global_id.x;

    let inputOffset = batchIndex * (uniforms.M * uniforms.K) + m * uniforms.K;
    let biasOffsetQ = headNumber * uniforms.head_size;
    let biasOffsetK = uniforms.hidden_size + biasOffsetQ;
    let biasOffsetV = uniforms.hidden_size + biasOffsetK;

    var valueQ = ${w}(0);
    var valueK = ${w}(0);
    var valueV = ${w}(0);
    for (var w: u32 = 0u; w < uniforms.K; w += TILE_SIZE) {
      if (m < uniforms.M && w + local_id.x < uniforms.K) {
        tileInput[TILE_SIZE * local_id.y + local_id.x] = input[inputOffset + w + local_id.x];
      }
      if (n < uniforms.N && w + local_id.y < uniforms.K) {
        let offset = n + (w + local_id.y) * uniforms.ldb;
        tileWeightQ[TILE_SIZE * local_id.y + local_id.x] = weight[biasOffsetQ + offset];
        tileWeightK[TILE_SIZE * local_id.y + local_id.x] = weight[biasOffsetK + offset];
        tileWeightV[TILE_SIZE * local_id.y + local_id.x] = weight[biasOffsetV + offset];
      }
      workgroupBarrier();
      for (var k: u32 = 0u; k<TILE_SIZE && w+k < uniforms.K; k++) {
        let inputTileOffset = TILE_SIZE * local_id.y + k;
        let weightTileOffset = TILE_SIZE * k + local_id.x;
        valueQ += tileInput[inputTileOffset] * tileWeightQ[weightTileOffset];
        valueK += tileInput[inputTileOffset] * tileWeightK[weightTileOffset];
        valueV += tileInput[inputTileOffset] * tileWeightV[weightTileOffset];
      }

      workgroupBarrier();
    }

    let headOffset = (m * uniforms.N + n) % uniforms.head_size;
    valueQ += bias[headOffset + biasOffsetQ];
    valueK += bias[headOffset + biasOffsetK];
    valueV += bias[headOffset + biasOffsetV];

    let offset = workgroup_id.z * uniforms.M * uniforms.N;
    if (m < uniforms.M && n < uniforms.N) {
      let outputIdx = offset + m * uniforms.N + n;
      output_q[outputIdx] = valueQ;
      output_k[outputIdx] = valueK;
      output_v[outputIdx] = valueV;
    }
  }`};return e.compute({name:"AttentionPrepare",shaderCache:{inputDependencies:["type","type","type"]},getRunData:()=>({outputs:[{dims:r,dataType:e.inputs[0].dataType,gpuDataType:0},{dims:r,dataType:e.inputs[0].dataType,gpuDataType:0},{dims:r,dataType:e.inputs[0].dataType,gpuDataType:0}],dispatchGroup:u,programUniforms:p}),getShaderSource:h},{inputs:l,outputs:[-1,-1,-1]})},Vp=(e,t)=>{let r=ru(e.inputs,t),[i,a,s]=su(e,r);return cr(e,i,a,s,e.inputs[4],void 0,void 0,void 0,e.inputs[5],r)}}),ou,uu,lu,Gp,r0=U(()=>{We(),te(),ie(),xe(),ae(),ou=(e,t)=>{if(!e||e.length!==5)throw new Error("BatchNormalization requires 5 inputs");let r=(i,a,s)=>{let n=a.length;if(n!==i.length)throw new Error(`${s}: num dimensions != ${n}`);a.forEach((u,l)=>{if(u!==i[l])throw new Error(`${s}: dim[${l}] do not match`)})};if(e[0].dims.length>1){let i=t.format==="NHWC"?t.spatial?e[0].dims.slice(-1):e[0].dims.slice(-1).concat(e[0].dims.slice(1,e[0].dims.length-1)):e[0].dims.slice(1,t.spatial?2:void 0);r(e[1].dims,i,"Invalid input scale"),r(e[2].dims,i,"Invalid input B"),r(e[3].dims,i,"Invalid input mean"),r(e[4].dims,i,"Invalid input var")}else r(e[1].dims,[1],"Invalid input scale"),r(e[2].dims,[1],"Invalid input B"),r(e[3].dims,[1],"Invalid input mean"),r(e[4].dims,[1],"Invalid input var")},uu=(e,t)=>{let{epsilon:r,spatial:i,format:a}=t,s=e[0].dims,n=i?ve(s[s.length-1]):1,u=a==="NHWC"&&s.length>1?n:1,l=R.size(s)/n,p=i,h=p?s.length:s,m=N("x",e[0].dataType,e[0].dims,n),g=N("scale",e[1].dataType,e[1].dims,u),y=N("bias",e[2].dataType,e[2].dims,u),_=N("inputMean",e[3].dataType,e[3].dims,u),b=N("inputVar",e[4].dataType,e[4].dims,u),S=Q("y",e[0].dataType,h,n),v=()=>{let I="";if(i)I=`let cOffset = ${s.length===1?"0u":a==="NHWC"?`outputIndices[${s.length-1}] / ${n}`:"outputIndices[1]"};`;else if(a==="NCHW")I=`
            ${S.indicesSet("outputIndices","0","0")}
            let cOffset = ${S.indicesToOffset("outputIndices")};`;else{I=`var cIndices = ${g.type.indices}(0);
                       cIndices[0] = outputIndices[${s.length-1}];`;for(let k=1;k<g.rank;k++)I+=`cIndices[${k}] = outputIndices[${k}];`;I+=`let cOffset = ${g.indicesToOffset("cIndices")};`}return I},w=I=>`
  const epsilon = ${r};
  ${I.registerUniform("outputSize","u32").declareVariables(m,g,y,_,b,S)}
  ${I.mainStart()}
  ${I.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.outputSize")}
    var outputIndices = ${S.offsetToIndices(`global_idx * ${n}`)};
    ${v()}
    let scale = ${g.getByOffset("cOffset")};
    let bias = ${y.getByOffset("cOffset")};
    let inputMean = ${_.getByOffset("cOffset")};
    let inputVar = ${b.getByOffset("cOffset")};
    let x = ${m.getByOffset("global_idx")};
    let value = (x - inputMean) * inverseSqrt(inputVar + epsilon) * scale + bias;
    ${S.setByOffset("global_idx","value")}
  }`;return{name:"BatchNormalization",shaderCache:{hint:`${t.epsilon}_${t.format}_${i}_${n}`,inputDependencies:p?["rank","type","type","type","type"]:void 0},getShaderSource:w,getRunData:()=>({outputs:[{dims:e[0].dims,dataType:e[0].dataType}],dispatchGroup:{x:Math.ceil(l/64)},programUniforms:p?[{type:12,data:l},...ee(s)]:[{type:12,data:l}]})}},lu=e=>fe(e),Gp=(e,t)=>{let{inputs:r,outputCount:i}=e,a=lu({...t,outputCount:i});if(we.webgpu.validateInputContent&&ou(r,a),t.trainingMode)throw new Error("BatchNormalization trainingMode is not supported yet.");e.compute(uu(r,a))}}),du,pu,Hp,i0=U(()=>{ie(),ae(),du=e=>{if(e[0].dims.length!==3)throw new Error("input should have 3 dimensions");if(![320,640,1280].includes(e[0].dims[2]))throw new Error("number of channels should be 320, 640 or 1280");if(e[1].dims.length!==1)throw new Error("bias is expected to have 1 dimensions");if(e[0].dims[2]!==e[1].dims[0])throw new Error("last dimension of input and bias are not the same")},pu=e=>{let t=e[0].dims,r=e[0].dims[2],i=R.size(t)/4,a=e[0].dataType,s=N("input",a,t,4),n=N("bias",a,[r],4),u=N("residual",a,t,4),l=Q("output",a,t,4);return{name:"BiasAdd",getRunData:()=>({outputs:[{dims:t,dataType:e[0].dataType}],dispatchGroup:{x:Math.ceil(i/64)}}),getShaderSource:p=>`
  const channels = ${r}u / 4;
  ${p.declareVariables(s,n,u,l)}

  ${p.mainStart()}
    ${p.guardAgainstOutOfBoundsWorkgroupSizes(i)}
    let value = ${s.getByOffset("global_idx")}
      + ${n.getByOffset("global_idx % channels")} + ${u.getByOffset("global_idx")};
    ${l.setByOffset("global_idx","value")}
  }`}},Hp=e=>{du(e.inputs),e.compute(pu(e.inputs))}}),cu,ce,Fp,jp,Kp,Zp,Xp,Qp,Yp,Jp,ec,hu,tc,rc,ic,ac,ur,nc,qr,sc,oc,uc,lc,dc,pc,cc,hc,fc,mc,gc,yc,_c,bc,$c,wc,Pi,vc,wa,va,xc,Sc,kc,fu,mu,Tc,Ha=U(()=>{te(),ie(),xe(),ae(),cu=(e,t,r,i,a,s,n)=>{let u=Math.ceil(t/4),l="";typeof a=="string"?l=`${a}(a)`:l=a("a");let p=N("inputData",r,[u],4),h=Q("outputData",i,[u],4),m=[{name:"vec_size",type:"u32"}];return n&&m.push(...n),`
      ${e.registerUniforms(m).declareVariables(p,h)}

  ${s!=null?s:""}

  ${e.mainStart()}
    ${e.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.vec_size")}

    let a = ${p.getByOffset("global_idx")};
    ${h.setByOffset("global_idx",l)}
  }`},ce=(e,t,r,i,a,s=e.dataType,n,u)=>{let l=[{type:12,data:Math.ceil(R.size(e.dims)/4)}];return n&&l.push(...n),{name:t,shaderCache:{hint:a,inputDependencies:["type"]},getShaderSource:p=>cu(p,R.size(e.dims),e.dataType,s,r,i,u),getRunData:p=>({outputs:[{dims:e.dims,dataType:s}],dispatchGroup:{x:Math.ceil(R.size(p[0].dims)/64/4)},programUniforms:l})}},Fp=e=>{e.compute(ce(e.inputs[0],"Abs","abs"))},jp=e=>{e.compute(ce(e.inputs[0],"Acos","acos"))},Kp=e=>{e.compute(ce(e.inputs[0],"Acosh","acosh"))},Zp=e=>{e.compute(ce(e.inputs[0],"Asin","asin"))},Xp=e=>{e.compute(ce(e.inputs[0],"Asinh","asinh"))},Qp=e=>{e.compute(ce(e.inputs[0],"Atan","atan"))},Yp=e=>{e.compute(ce(e.inputs[0],"Atanh","atanh"))},Jp=e=>fe(e),ec=(e,t)=>{let r;switch(t.to){case 10:r="vec4<f16>";break;case 1:r="vec4<f32>";break;case 12:r="vec4<u32>";break;case 6:r="vec4<i32>";break;case 9:r="vec4<bool>";break;default:throw new RangeError(`not supported type (specified in attribute 'to' from 'Cast' operator): ${t.to}`)}e.compute(ce(e.inputs[0],"Cast",r,void 0,t.cacheKey,t.to))},hu=e=>{let t,r,i=e.length>=2&&e[1].data!==0,a=e.length>=3&&e[2].data!==0;switch(e[0].dataType){case 1:t=i?e[1].getFloat32Array()[0]:-34028234663852886e22,r=a?e[2].getFloat32Array()[0]:34028234663852886e22;break;case 10:t=i?e[1].getUint16Array()[0]:64511,r=a?e[2].getUint16Array()[0]:31743;break;default:throw new Error("Unsupport data type")}return fe({min:t,max:r})},tc=(e,t)=>{let r=t||hu(e.inputs),i=ze(e.inputs[0].dataType);e.compute(ce(e.inputs[0],"Clip",a=>`clamp(${a}, vec4<${i}>(uniforms.min), vec4<${i}>(uniforms.max))`,void 0,r.cacheKey,void 0,[{type:e.inputs[0].dataType,data:r.min},{type:e.inputs[0].dataType,data:r.max}],[{name:"min",type:i},{name:"max",type:i}]),{inputs:[0]})},rc=e=>{e.compute(ce(e.inputs[0],"Ceil","ceil"))},ic=e=>{e.compute(ce(e.inputs[0],"Cos","cos"))},ac=e=>{e.compute(ce(e.inputs[0],"Cosh","cosh"))},ur=e=>fe(e),nc=(e,t)=>{let r=ze(e.inputs[0].dataType);e.compute(ce(e.inputs[0],"Elu",i=>`elu_vf32(${i})`,`
  const elu_alpha_ = ${r}(${t.alpha});

  fn elu_f32(a: ${r}) -> ${r} {
  return select((exp(a) - 1.0) * elu_alpha_, a, a >= 0.0);
  }

  fn elu_vf32(v: vec4<${r}>) -> vec4<${r}> {
  return vec4(elu_f32(v.x), elu_f32(v.y), elu_f32(v.z), elu_f32(v.w));
  }`,t.cacheKey))},qr=(e="f32")=>`
const r0: ${e} = 0.3275911;
const r1: ${e} = 0.254829592;
const r2: ${e} = -0.284496736;
const r3: ${e} = 1.421413741;
const r4: ${e} = -1.453152027;
const r5: ${e} = 1.061405429;

fn erf_vf32(v: vec4<${e}>) -> vec4<${e}> {
  let absv = abs(v);
  let x = 1.0 / (1.0 + r0 * absv);
  return sign(v) * (1.0 - ((((r5 * x + r4) * x + r3) * x + r2) * x + r1) * x * exp(-absv * absv));
}`,sc=e=>{let t=ze(e.inputs[0].dataType);e.compute(ce(e.inputs[0],"Erf",r=>`erf_vf32(${r})`,qr(t)))},oc=e=>{e.compute(ce(e.inputs[0],"Exp","exp"))},uc=e=>{e.compute(ce(e.inputs[0],"Floor","floor"))},lc=e=>{let t=ze(e.inputs[0].dataType);e.compute(ce(e.inputs[0],"Gelu",r=>`0.5 * ${r} * (1.0 + erf_vf32(${r} * 0.7071067811865475))`,qr(t)))},dc=(e,t)=>{let r=ze(e.inputs[0].dataType);e.compute(ce(e.inputs[0],"LeakyRelu",i=>`select(leaky_relu_alpha_ * ${i}, ${i}, ${i} >= vec4<${r}>(0.0))`,`const leaky_relu_alpha_ = ${r}(${t.alpha});`,t.cacheKey))},pc=e=>{e.compute(ce(e.inputs[0],"Not",t=>`!${t}`))},cc=e=>{e.compute(ce(e.inputs[0],"Neg",t=>`-${t}`))},hc=e=>{e.compute(ce(e.inputs[0],"Reciprocal",t=>`1.0/${t}`))},fc=e=>{let t=ze(e.inputs[0].dataType);e.compute(ce(e.inputs[0],"Relu",r=>`select(vec4<${t}>(0.0), ${r}, ${r} > vec4<${t}>(0.0))`))},mc=e=>{e.compute(ce(e.inputs[0],"Sigmoid",t=>`(1.0 / (1.0 + exp(-${t})))`))},gc=e=>fe(e),yc=(e,t)=>{let r=ze(e.inputs[0].dataType);e.compute(ce(e.inputs[0],"HardSigmoid",i=>`max(vec4<${r}>(0.0), min(vec4<${r}>(1.0), ${t.alpha} * ${i} + vec4<${r}>(${t.beta})))`,void 0,t.cacheKey))},_c=e=>{e.compute(ce(e.inputs[0],"Sin","sin"))},bc=e=>{e.compute(ce(e.inputs[0],"Sinh","sinh"))},$c=e=>{e.compute(ce(e.inputs[0],"Sqrt","sqrt"))},wc=e=>{e.compute(ce(e.inputs[0],"Tan","tan"))},Pi=e=>`sign(${e}) * (1 - exp(-2 * abs(${e}))) / (1 + exp(-2 * abs(${e})))`,vc=e=>{e.compute(ce(e.inputs[0],"Tanh",Pi))},wa=(e="f32")=>`
const fast_gelu_a: ${e} = 0.5;
const fast_gelu_b: ${e} = 0.7978845608028654;
const fast_gelu_c: ${e} = 0.035677408136300125;

fn tanh_v(v: vec4<${e}>) -> vec4<${e}> {
  return ${Pi("v")};
}
`,va=e=>`(fast_gelu_a + fast_gelu_a * tanh_v(${e} * (fast_gelu_c * ${e} * ${e} + fast_gelu_b))) * ${e}`,xc=e=>{let t=ze(e.inputs[0].dataType);e.compute(ce(e.inputs[0],"FastGelu",va,wa(t),void 0,e.inputs[0].dataType))},Sc=(e,t)=>{let r=ze(e.inputs[0].dataType);return e.compute(ce(e.inputs[0],"ThresholdedRelu",i=>`select(vec4<${r}>(0.0), ${i}, ${i} > thresholded_relu_alpha_)`,`const thresholded_relu_alpha_ = vec4<${r}>(${t.alpha});`,t.cacheKey)),0},kc=e=>{e.compute(ce(e.inputs[0],"Log","log"))},fu=(e,t)=>`
const alpha = vec4<${e}>(${t});
const one = ${e}(1.0);
const zero = ${e}(0.0);

fn quick_gelu_impl(x: vec4<${e}>) -> vec4<${e}> {
  let v = x *alpha;
  var x1 : vec4<${e}>;
  for (var i = 0; i < 4; i = i + 1) {
    if (v[i] >= zero) {
      x1[i] = one / (one + exp(-v[i]));
    } else {
      x1[i] = one - one / (one + exp(v[i]));
    }
  }
  return x * x1;
}
`,mu=e=>`quick_gelu_impl(${e})`,Tc=(e,t)=>{let r=ze(e.inputs[0].dataType);e.compute(ce(e.inputs[0],"QuickGelu",mu,fu(r,t.alpha),t.cacheKey,e.inputs[0].dataType))}}),gu,yu,Ic,a0=U(()=>{ie(),ae(),Ha(),gu=e=>{if(e[0].dims.length!==3)throw new Error("input should have 3 dimensions");if(![2560,5120,10240].includes(e[0].dims[2]))throw new Error("hidden state should be 2560, 5120 or 10240");if(e[1].dims.length!==1)throw new Error("bias is expected to have 1 dimensions");if(e[0].dims[2]!==e[1].dims[0])throw new Error("last dimension of input and bias are not the same")},yu=e=>{let t=e[0].dims.slice();t[2]=t[2]/2;let r=N("input",e[0].dataType,e[0].dims,4),i=N("bias",e[0].dataType,[e[0].dims[2]],4),a=Q("output",e[0].dataType,t,4),s=R.size(t)/4,n=Te(e[0].dataType);return{name:"BiasSplitGelu",getRunData:()=>({outputs:[{dims:t,dataType:e[0].dataType}],dispatchGroup:{x:Math.ceil(s/64)}}),getShaderSource:u=>`
  const M_SQRT2 = sqrt(2.0);
  const halfChannels = ${e[0].dims[2]/4/2}u;

  ${u.declareVariables(r,i,a)}

  ${qr(n)}

  ${u.mainStart()}
    ${u.guardAgainstOutOfBoundsWorkgroupSizes(s)}
    let biasIdx = global_idx % halfChannels;
    let batchIndex = global_idx / halfChannels;
    let inputOffset = biasIdx + batchIndex * halfChannels * 2;
    let valueLeft = input[inputOffset] + bias[biasIdx];
    let valueRight = input[inputOffset + halfChannels] + bias[biasIdx + halfChannels];
    let geluRight = valueRight * 0.5 * (erf_vf32(valueRight / M_SQRT2) + 1);

    ${a.setByOffset("global_idx","valueLeft * geluRight")}
  }`}},Ic=e=>{gu(e.inputs),e.compute(yu(e.inputs))}}),_u,bu,Ke,Ec,zc,Cc,Ac,Oc,Rc,Bc,Nc,Mc,Dc,n0=U(()=>{te(),ie(),ae(),_u=(e,t,r,i,a,s,n,u,l,p,h,m)=>{let g,y;typeof u=="string"?g=y=(w,I)=>`${u}((${w}),(${I}))`:typeof u=="function"?g=y=u:(g=u.scalar,y=u.vector);let _=Q("outputData",h,i.length,4),b=N("aData",l,t.length,4),S=N("bData",p,r.length,4),v;if(a)if(s){let w=R.size(t)===1,I=R.size(r)===1,k=t.length>0&&t[t.length-1]%4===0,E=r.length>0&&r[r.length-1]%4===0;w||I?v=_.setByOffset("global_idx",y(w?`${b.type.value}(${b.getByOffset("0")}.x)`:b.getByOffset("global_idx"),I?`${S.type.value}(${S.getByOffset("0")}.x)`:S.getByOffset("global_idx"))):v=`
            let outputIndices = ${_.offsetToIndices("global_idx * 4u")};
            let offsetA = ${b.broadcastedIndicesToOffset("outputIndices",_)};
            let offsetB = ${S.broadcastedIndicesToOffset("outputIndices",_)};
            ${_.setByOffset("global_idx",y(n||k?b.getByOffset("offsetA / 4u"):`${b.type.value}(${b.getByOffset("offsetA / 4u")}[offsetA % 4u])`,n||E?S.getByOffset("offsetB / 4u"):`${S.type.value}(${S.getByOffset("offsetB / 4u")}[offsetB % 4u])`))}
          `}else v=_.setByOffset("global_idx",y(b.getByOffset("global_idx"),S.getByOffset("global_idx")));else{if(!s)throw new Error("no necessary to use scalar implementation for element-wise binary op implementation.");let w=(I,k,E="")=>{let A=`aData[indexA${k}][componentA${k}]`,C=`bData[indexB${k}][componentB${k}]`;return`
            let outputIndices${k} = ${_.offsetToIndices(`global_idx * 4u + ${k}u`)};
            let offsetA${k} = ${b.broadcastedIndicesToOffset(`outputIndices${k}`,_)};
            let offsetB${k} = ${S.broadcastedIndicesToOffset(`outputIndices${k}`,_)};
            let indexA${k} = offsetA${k} / 4u;
            let indexB${k} = offsetB${k} / 4u;
            let componentA${k} = offsetA${k} % 4u;
            let componentB${k} = offsetB${k} % 4u;
            ${I}[${k}] = ${E}(${g(A,C)});
          `};h===9?v=`
            var data = vec4<u32>(0);
            ${w("data",0,"u32")}
            ${w("data",1,"u32")}
            ${w("data",2,"u32")}
            ${w("data",3,"u32")}
            outputData[global_idx] = dot(vec4<u32>(0x1, 0x100, 0x10000, 0x1000000), vec4<u32>(data));`:v=`
            ${w("outputData[global_idx]",0)}
            ${w("outputData[global_idx]",1)}
            ${w("outputData[global_idx]",2)}
            ${w("outputData[global_idx]",3)}
          `}return`
        ${e.registerUniform("vec_size","u32").declareVariables(b,S,_)}

        ${m!=null?m:""}

        ${e.mainStart()}
        ${e.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.vec_size")}
        ${v}
      }`},bu=(e,t,r,i,a,s,n=r.dataType)=>{let u=r.dims.map(Number),l=i.dims.map(Number),p=!R.areEqual(u,l),h=u,m=R.size(u),g=!1,y=!1,_=[p];if(p){let b=Wt.calcShape(u,l,!1);if(!b)throw new Error("Can't perform binary op on the given tensors");h=b.slice(),m=R.size(h);let S=R.size(u)===1,v=R.size(l)===1,w=u.length>0&&u[u.length-1]%4===0,I=l.length>0&&l[l.length-1]%4===0;_.push(S),_.push(v),_.push(w),_.push(I);let k=1;for(let E=1;E<h.length;E++){let A=u[u.length-E],C=l[l.length-E];if(A===C)k*=A;else break}k%4===0?(y=!0,g=!0):(S||v||w||I)&&(g=!0)}else g=!0;return _.push(g),{name:e,shaderCache:{hint:t+_.map(b=>b.toString()).join("_"),inputDependencies:["rank","rank"]},getShaderSource:b=>_u(b,u,l,h,g,p,y,a,r.dataType,i.dataType,n,s),getRunData:()=>({outputs:[{dims:h,dataType:n}],dispatchGroup:{x:Math.ceil(m/64/4)},programUniforms:[{type:12,data:Math.ceil(R.size(h)/4)},...ee(u,l,h)]})}},Ke=(e,t,r,i,a,s)=>{e.compute(bu(t,a!=null?a:"",e.inputs[0],e.inputs[1],r,i,s))},Ec=e=>{Ke(e,"Add",(t,r)=>`${t}+${r}`)},zc=e=>{Ke(e,"Div",(t,r)=>`${t}/${r}`)},Cc=e=>{Ke(e,"Equal",{scalar:(t,r)=>`u32(${t}==${r})`,vector:(t,r)=>`vec4<u32>(${t}==${r})`},void 0,void 0,9)},Ac=e=>{Ke(e,"Mul",(t,r)=>`${t}*${r}`)},Oc=e=>{let t=N("input",e.inputs[0].dataType,e.inputs[0].dims).type.value;Ke(e,"Pow",{scalar:(r,i)=>`pow_custom(${r},${i})`,vector:(r,i)=>`pow_vector_custom(${r},${i})`},`
    fn pow_custom(a : ${t}, b : ${t}) -> ${t} {
      if (b == ${t}(0.0)) {
        return ${t}(1.0);
      } else if (a < ${t}(0.0) && f32(b) != floor(f32(b))) {
        return ${t}(pow(f32(a), f32(b))); // NaN
      }
      return select(sign(a), ${t}(1.0), round(f32(abs(b) % ${t}(2.0))) != 1.0) * ${t}(${t==="i32"?"round":""}(pow(f32(abs(a)), f32(b))));
    }
    fn pow_vector_custom(a : vec4<${t}>, b : vec4<${t}>) -> vec4<${t}> {
      // TODO: implement vectorized pow
      return vec4<${t}>(pow_custom(a.x, b.x), pow_custom(a.y, b.y), pow_custom(a.z, b.z), pow_custom(a.w, b.w));
    }
      `)},Rc=e=>{Ke(e,"Sub",(t,r)=>`${t}-${r}`)},Bc=e=>{Ke(e,"Greater",{scalar:(t,r)=>`u32(${t}>${r})`,vector:(t,r)=>`vec4<u32>(${t}>${r})`},void 0,void 0,9)},Nc=e=>{Ke(e,"Less",{scalar:(t,r)=>`u32(${t}<${r})`,vector:(t,r)=>`vec4<u32>(${t}<${r})`},void 0,void 0,9)},Mc=e=>{Ke(e,"GreaterOrEqual",{scalar:(t,r)=>`u32(${t}>=${r})`,vector:(t,r)=>`vec4<u32>(${t}>=${r})`},void 0,void 0,9)},Dc=e=>{Ke(e,"LessOrEqual",{scalar:(t,r)=>`u32(${t}<=${r})`,vector:(t,r)=>`vec4<u32>(${t}<=${r})`},void 0,void 0,9)}}),$u,wu,vu,xu,Uc,Pc,s0=U(()=>{te(),ie(),xe(),ae(),$u=(e,t)=>{if(!e||e.length<1)throw new Error("too few inputs");let r=0,i=e[r],a=i.dataType,s=i.dims.length;e.forEach((n,u)=>{if(u!==r){if(n.dataType!==a)throw new Error("input tensors should be one type");if(n.dims.length!==s)throw new Error("input tensors should have the same shape");n.dims.forEach((l,p)=>{if(p!==t&&l!==i.dims[p])throw new Error("non concat dimensions must match")})}})},wu=(e,t)=>`
  fn calculateInputIndex(index: u32) -> u32 {
    let sizeInConcatAxis = array<u32, ${e}u>(${t});
    for (var i: u32 = 0u; i < ${e}; i += 1u ) {
      if (index < sizeInConcatAxis[i]) {
        return i;
      }
    }
    return ${e}u;
  }`,vu=(e,t)=>{let r=e.length,i=[];for(let a=0;a<r;++a){let s=t.setByOffset("global_idx",e[a].getByIndices("indices"));r===1?i.push(s):a===0?i.push(`if (inputIndex == ${a}u) { ${s} }`):a===r-1?i.push(`else { ${s} }`):i.push(`else if (inputIndex == ${a}) { ${s} }`)}return i.join(`
`)},xu=(e,t,r,i)=>{let a=R.size(r),s=new Array(e.length),n=new Array(e.length),u=0,l=[],p=[],h=[{type:12,data:a}];for(let b=0;b<e.length;++b)u+=e[b].dims[t],s[b]=u,p.push(e[b].dims.length),n[b]=N(`input${b}`,i,p[b]),l.push("rank"),h.push({type:12,data:s[b]});for(let b=0;b<e.length;++b)h.push(...ee(e[b].dims));h.push(...ee(r));let m=Q("output",i,r.length),g=m.indicesGet("indices",t),y=Array.from(Array(s.length).keys()).map(b=>`uniforms.sizeInConcatAxis${b}`).join(","),_=b=>`

  ${(()=>{b.registerUniform("outputSize","u32");for(let S=0;S<e.length;S++)b.registerUniform(`sizeInConcatAxis${S}`,"u32");return b.declareVariables(...n,m)})()}

  ${wu(s.length,y)}

  ${b.mainStart()}
    ${b.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.outputSize")}

    var indices = ${m.offsetToIndices("global_idx")};

    let inputIndex = calculateInputIndex(${g});
    if (inputIndex != 0u) {
      let sizeInConcatAxis = array<u32, ${s.length}u>(${y});
      ${g} -= sizeInConcatAxis[inputIndex - 1u];
    }

    ${vu(n,m)}
  }`;return{name:"Concat",shaderCache:{hint:`${t}`,inputDependencies:l},getRunData:()=>({outputs:[{dims:r,dataType:i}],dispatchGroup:{x:Math.ceil(a/64)},programUniforms:h}),getShaderSource:_}},Uc=(e,t)=>{let r=e.inputs,i=r[0].dims,a=R.normalizeAxis(t.axis,i.length);$u(r,a);let s=i.slice();s[a]=r.reduce((u,l)=>u+(l.dims.length>a?l.dims[a]:0),0);let n=r.filter(u=>R.size(u.dims)>0);e.compute(xu(n,a,s,r[0].dataType),{inputs:n})},Pc=e=>fe({axis:e.axis})}),Ot,Rt,Bt,Fa,Mt=U(()=>{te(),ie(),Ot=(e,t,r="f32")=>{switch(e.activation){case"Relu":return`value = max(value, ${t}(0.0));`;case"Sigmoid":return`value = (${t}(1.0) / (${t}(1.0) + exp(-value)));`;case"Clip":return`value = clamp(value, ${t}(${r}(uniforms.clip_min)), ${t}(${r}(uniforms.clip_max)));`;case"HardSigmoid":return`value = max(${t}(0.0), min(${t}(1.0), ${r}(uniforms.alpha) * value + ${r}(uniforms.beta)));`;case"LeakyRelu":return`value = select(${r}(uniforms.alpha) * value, value, value >= ${t}(0.0));`;case"Tanh":return`let e2x = exp(-2.0 * abs(value));
              value = sign(value) * (1.0 - e2x) / (1.0 + e2x);
        `;case"":return"";default:throw new Error(`Unsupported activation ${e.activation}`)}},Rt=(e,t)=>{e.activation==="Clip"?t.push({type:1,data:e.clipMax},{type:1,data:e.clipMin}):e.activation==="HardSigmoid"?t.push({type:1,data:e.alpha},{type:1,data:e.beta}):e.activation==="LeakyRelu"&&t.push({type:1,data:e.alpha})},Bt=(e,t)=>{e.activation==="Clip"?t.push({name:"clip_max",type:"f32"},{name:"clip_min",type:"f32"}):e.activation==="HardSigmoid"?t.push({name:"alpha",type:"f32"},{name:"beta",type:"f32"}):e.activation==="LeakyRelu"&&t.push({name:"alpha",type:"f32"})},Fa=e=>{let t=(e==null?void 0:e.activation)||"";if(t==="HardSigmoid"){let[r,i]=(e==null?void 0:e.activation_params)||[.2,.5];return{activation:t,alpha:r,beta:i}}else if(t==="Clip"){let[r,i]=(e==null?void 0:e.activation_params)||[pp,cp];return{activation:t,clipMax:i,clipMin:r}}else if(t==="LeakyRelu"){let[r]=(e==null?void 0:e.activation_params)||[.01];return{activation:t,alpha:r}}return{activation:t}}}),Ee,qc,ja=U(()=>{Ee=(e,t)=>{switch(e){case 1:return t;case 2:return`vec2<${t}>`;case 3:return`vec3<${t}>`;case 4:return`vec4<${t}>`;default:throw new Error(`${e}-component is not supported.`)}},qc=e=>`
      ${e?"value = value + getBiasByOutputCoords(coords);":""}
      `}),Lc,o0=U(()=>{Lc=e=>`
fn getIndexFromCoords4D(coords : vec4<i32>, shape : vec4<i32>) -> i32 {
  return dot(coords, vec4<i32>(
      shape.y * shape.z * shape.w, shape.z * shape.w, shape.w, 1));
}
fn getOutputIndexFromCoords(coords : vec4<i32>) -> i32 {
  return dot(coords, vec4<i32>(
    i32(${e}.x), i32(${e}.y), i32(${e}.z), 1));
}
`}),dr,Ka,Za=U(()=>{te(),ie(),ae(),Mt(),dr=(e,t,r,i,a)=>{let s=i-r;return`
      ${Array.from({length:r}).map((n,u)=>`
      if (${J(t.shape,u,t.rank)} != 1) {
        ${t.indicesSet(e,u,J(a,u+s,i))}
      } else {
        ${t.indicesSet(e,u,0)}
      }`).join("")}
`},Ka=(e,t,r,i,a=!1,s)=>{let n=e[0].dims,u=e[1].dims,l=n[n.length-2],p=u[u.length-1],h=n[n.length-1],m=ve(p),g=ve(h),y=ve(l),_=R.size(r)/m/y,b=e.length>2,S=i?i.slice(0,-2):r.slice(0,-2),v=[R.size(S),l,p],w=[{type:12,data:_},{type:12,data:l},{type:12,data:p},{type:12,data:h}];Rt(t,w),w.push(...ee(S,n,u)),b&&w.push(...ee(e[2].dims)),w.push(...ee(v));let I=k=>{let E=Wa("batch_dims",e[0].dataType,S.length),A=N("a",e[0].dataType,n.length,g),C=N("b",e[1].dataType,u.length,m),x=Q("output",e[0].dataType,v.length,m),D=Te(x.type.tensor),M=Ot(t,x.type.value,D),P=[A,C],K="";if(b){let G=a?m:1;P.push(N("bias",e[2].dataType,e[2].dims.length,G)),K=`${a?`value += bias[col / ${G}];`:`value += ${x.type.value}(bias[row + i]);`}`}let Z=[{name:"output_size",type:"u32"},{name:"M",type:"u32"},{name:"N",type:"u32"},{name:"K",type:"u32"}];Bt(t,Z);let O=()=>{let G=`var a_data: ${A.type.value};`;for(let F=0;F<g;F++)G+=`
              let b_data${F} = b[(b_offset + (k + ${F}) * uniforms.N + col) / ${m}];`;for(let F=0;F<y;F++){G+=`a_data = a[(a_offset + (row + ${F}) * uniforms.K + k) / ${g}];`;for(let Y=0;Y<g;Y++)G+=`
            values[${F}] = fma(${C.type.value}(a_data${g===1?"":`[${Y}]`}), b_data${Y}, values[${F}]);
`}return G};return`
  ${k.registerUniforms(Z).registerInternalVariables(E).declareVariables(...P,x)}
  ${k.mainStart()}
    ${k.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.output_size")}
    let col = (global_idx % (uniforms.N / ${m})) * ${m};
    var index1 = global_idx / (uniforms.N / ${m});
    let stride1 = uniforms.M / ${y};
    let row = (index1 % stride1) * ${y};
    let batch = index1 / stride1;

    ${r.length===2?"":`let batch_indices = ${E.offsetToIndices("batch")};`}

    var a_indices: ${A.type.indices};
    ${dr("a_indices",A,A.rank-2,E.rank,"batch_indices")}
    ${A.indicesSet("a_indices",A.rank-2,0)}
    ${A.indicesSet("a_indices",A.rank-1,0)}
    let a_offset = ${A.indicesToOffset("a_indices")};

    var b_indices: ${C.type.indices};
    ${dr("b_indices",C,C.rank-2,E.rank,"batch_indices")}
    ${C.indicesSet("b_indices",C.rank-2,0)}
    ${C.indicesSet("b_indices",C.rank-1,0)}
    let b_offset = ${C.indicesToOffset("b_indices")};
    var values: array<${x.type.value}, ${y}>;
    for (var k: u32 = 0u; k < uniforms.K; k = k + ${g}) {
      ${O()}
    }
    for (var i = 0u; i < ${y}u; i++) {
      var value = values[i];
      ${K}
      ${M}
      let cur_indices = ${x.type.indices}(batch, row + i, col);
      let offset = ${x.indicesToOffset("cur_indices")};
      ${x.setByOffset(`offset / ${m}`,"value")};
    }
  }
  `};return{name:"MatMulNaive",shaderCache:{hint:`${t.activation};${m};${g};${y};${a}`,inputDependencies:b?["rank","rank","rank"]:["rank","rank"]},getRunData:()=>({outputs:[{dims:s?s(r):r,dataType:e[0].dataType}],dispatchGroup:{x:Math.ceil(_/64)},programUniforms:w}),getShaderSource:I}}}),Su,ku,xa,qi,Tu,Sa,Iu,Fr,Xa=U(()=>{te(),ie(),ae(),Mt(),Za(),ja(),Su=(e,t)=>e?`
        mm_Asub[inputRow][inputCol] = mm_readA(batch,
          kStart + inputRow,
          globalRowStart / innerElementSize + inputCol${t?", batchIndices":""});
        `:`
        mm_Asub[inputRow][inputCol] = mm_readA(batch,
          globalRow + innerRow,
          kStart / innerElementSize + inputCol${t?", batchIndices":""});
        `,ku=(e,t)=>e?`
        let ACached0 = mm_Asub[k * innerElementSize][localRow];
        let ACached1 = mm_Asub[k * innerElementSize + 1][localRow];
        let ACached2 = mm_Asub[k * innerElementSize + 2][localRow];
        ${t===3?"":"let ACached3 = mm_Asub[k * innerElementSize + 3][localRow];"}
        for (var i = 0; i < rowPerThread; i = i + 1) {
          acc[i] = BCached0 * ACached0[i] + acc[i];
          acc[i] = BCached1 * ACached1[i] + acc[i];
          acc[i] = BCached2 * ACached2[i] + acc[i];
          ${t===3?"":"acc[i] = BCached3 * ACached3[i] + acc[i];"}
        }`:`
        for (var i = 0; i < rowPerThread; i = i + 1) {
          let ACached = mm_Asub[tileRow + i][k];
          acc[i] = BCached0 * ACached.x + acc[i];
          acc[i] = BCached1 * ACached.y + acc[i];
          acc[i] = BCached2 * ACached.z + acc[i];
          ${t===3?"":"acc[i] = BCached3 * ACached.w + acc[i];"}
        }`,xa=(e,t,r="f32",i,a=!1,s=32,n=!1,u=32)=>{let l=t[1]*e[1],p=t[0]*e[0],h=a?l:s,m=a?s:l,g=h/t[0],y=s/t[1];if(!((a&&g===4&&e[1]===4||!a&&(g===3||g===4))&&h%t[0]===0&&s%t[1]===0&&e[0]===4))throw new Error(`If transposeA ${a} is true, innerElementSize ${g} and workPerThread[1] ${e[1]} must be 4.
      Otherwise, innerElementSize ${g} must be 3 or 4.
  tileAWidth ${h} must be divisible by workgroupSize[0]${t[0]}. tileInner ${s} must be divisible by workgroupSize[1] ${t[1]}. colPerThread ${e[0]} must be 4.`);return`
var<workgroup> mm_Asub: array<array<vec${g}<${r}>, ${h/g}>, ${m}>;
var<workgroup> mm_Bsub: array<array<vec4<${r}>, ${p/e[0]}>, ${s}>;

const rowPerThread = ${e[1]};
const colPerThread = ${e[0]};
const innerElementSize = ${g};
const tileInner = ${s};

@compute @workgroup_size(${t[0]}, ${t[1]}, ${t[2]})
fn main(@builtin(local_invocation_id) localId : vec3<u32>,
        @builtin(global_invocation_id) globalId : vec3<u32>,
        @builtin(workgroup_id) workgroupId : vec3<u32>) {
  let localRow = i32(localId.y);
  let tileRow = localRow * rowPerThread;
  let tileCol = i32(localId.x);

  let globalRow =i32(globalId.y) * rowPerThread;
  let globalCol = i32(globalId.x);
  let batch = ${n?"0":"i32(globalId.z)"};
  ${i?`let batchIndices = ${i.offsetToIndices("u32(batch)")};`:""}
  let globalRowStart = i32(workgroupId.y) * ${l};

  let num_tiles = ${n?`${Math.ceil(u/s)}`:"(uniforms.dim_inner - 1) / tileInner + 1"};
  var kStart = ${n?`i32(globalId.z) * ${u}`:"0"};

  var acc: array<vec4<${r}>, rowPerThread>;

  // Loop over shared dimension.
  let tileRowB = localRow * ${y};
  for (var t = 0; t < num_tiles; t = t + 1) {
      // Load one tile of A into local memory.
      for (var innerRow = 0; innerRow < rowPerThread; innerRow = innerRow + 1) {
          let inputRow = tileRow + innerRow;
          let inputCol = tileCol;
          ${Su(a,i)}
      }

      // Load one tile of B into local memory.
      for (var innerRow = 0; innerRow < ${y}; innerRow = innerRow + 1) {
          let inputRow = tileRowB + innerRow;
          let inputCol = tileCol;
          mm_Bsub[inputRow][inputCol] = mm_readB(batch, kStart + inputRow, globalCol${i?", batchIndices":""});
      }
      kStart = kStart + tileInner;
      workgroupBarrier();

      // Compute acc values for a single thread.
      for (var k = 0; k < tileInner / innerElementSize; k = k + 1) {
          let BCached0 = mm_Bsub[k * innerElementSize][tileCol];
          let BCached1 = mm_Bsub[k * innerElementSize + 1][tileCol];
          let BCached2 = mm_Bsub[k * innerElementSize + 2][tileCol];
          ${g===3?"":"let BCached3 = mm_Bsub[k * innerElementSize + 3][tileCol];"}

          ${ku(a,g)}
      }

      workgroupBarrier();
  }

  for (var innerRow = 0; innerRow < rowPerThread; innerRow = innerRow + 1) {
      mm_write(batch, globalRow + innerRow, globalCol, acc[innerRow]);
  }
}`},qi=(e,t)=>e?`
            mm_Asub[inputRow][inputCol] = mm_readA(batch,
              kStart + inputRow,
              globalRowStart + inputCol${t?", batchIndices":""});
            `:`
            mm_Asub[inputRow][inputCol] = mm_readA(batch,
              globalRowStart + inputRow,
              kStart + inputCol${t?", batchIndices":""});
            `,Tu=e=>e?"let ACached = mm_Asub[k][tileRow + innerRow];":"let ACached = mm_Asub[tileRow + innerRow][k];",Sa=(e,t,r="f32",i,a=!1,s=32,n=!1,u=32,l=!1)=>{let p=e[1]*t[1],h=e[0]*t[0],m=a?p:s,g=a?s:p;if(!(g%t[1]===0&&m%t[0]===0&&s%t[1]===0))throw new Error(`tileAHight ${g} must be divisible by workgroupSize[1]${t[1]}, tileAWidth ${m} must be divisible by workgroupSize[0]${t[0]}, tileInner ${s} must be divisible by workgroupSize[1]${t[1]}`);let y=g/t[1],_=m/t[0],b=s/t[1],S=l?`
    let localRow = i32(localId.y);
    let localCol = i32(localId.x);
    let globalRowStart = i32(workgroupId.y) * ${p};
    let globalColStart = i32(workgroupId.x) * ${h};

    // Loop over shared dimension.
    for (var t = 0; t < num_tiles; t = t + 1) {
      // Load one tile of A into local memory.
      for (var inputRow = localRow; inputRow < ${g}; inputRow = inputRow + ${t[1]}) {
        for (var inputCol = localCol; inputCol < ${m}; inputCol = inputCol + ${t[0]}) {
          ${qi(a,i)}
        }
      }
      // Load one tile of B into local memory.
      for (var inputRow = localRow; inputRow < ${s}; inputRow = inputRow + ${t[1]}) {
            for (var inputCol = localCol; inputCol < ${h}; inputCol = inputCol + ${t[0]}) {
          mm_Bsub[inputRow][inputCol] = mm_readB(batch,
            kStart + inputRow,
            globalColStart + inputCol${i?", batchIndices":""});
        }
      }
      kStart = kStart + tileInner;
      workgroupBarrier();

      // Compute acc values for a single thread.
      var BCached : array<${r}, colPerThread>;
      for (var k = 0; k < tileInner; k = k + 1) {
        for (var inner = 0; inner < colPerThread; inner = inner + 1) {
          BCached[inner] = mm_Bsub[k][localCol + inner * ${t[0]}];
        }
        for (var innerRow = 0; innerRow < rowPerThread; innerRow = innerRow + 1) {
          let ACached = ${a?`mm_Asub[k][localRow + innerRow * ${t[1]}];`:`mm_Asub[localRow + innerRow * ${t[1]}][k];`}
          for (var innerCol = 0; innerCol < colPerThread; innerCol = innerCol + 1) {
            acc[innerRow][innerCol] = acc[innerRow][innerCol] +
                ACached * BCached[innerCol];
          }
        }
      }
      workgroupBarrier();
    }
    for (var innerRow = 0; innerRow < rowPerThread; innerRow = innerRow + 1) {
      let gRow = globalRowStart + localRow + innerRow * ${t[1]};
      for (var innerCol = 0; innerCol < colPerThread; innerCol = innerCol + 1) {
        let gCol = globalColStart + localCol + innerCol * ${t[0]};
        mm_write(batch, gRow, gCol, acc[innerRow][innerCol]);
      }
    }
    `:`
let tileRow = i32(localId.y) * rowPerThread;
let tileCol = i32(localId.x) * colPerThread;

let globalRow = i32(globalId.y) * rowPerThread;
let globalCol = i32(globalId.x) * colPerThread;
let globalRowStart = i32(workgroupId.y) * ${p};

let tileRowA = i32(localId.y) * ${y};
let tileColA = i32(localId.x) * ${_};
let tileRowB = i32(localId.y) * ${b};
// Loop over shared dimension.
for (var t = 0; t < num_tiles; t = t + 1) {
  // Load one tile of A into local memory.
  for (var innerRow = 0; innerRow < ${y}; innerRow = innerRow + 1) {
    for (var innerCol = 0; innerCol < ${_}; innerCol = innerCol + 1) {
      let inputRow = tileRowA + innerRow;
      let inputCol = tileColA + innerCol;
      ${qi(a,i)}
    }
  }

  // Load one tile of B into local memory.
  for (var innerRow = 0; innerRow < ${b}; innerRow = innerRow + 1) {
    for (var innerCol = 0; innerCol < colPerThread; innerCol = innerCol + 1) {
      let inputRow = tileRowB + innerRow;
      let inputCol = tileCol + innerCol;
      mm_Bsub[inputRow][inputCol] = mm_readB(batch,
        kStart + inputRow,
        globalCol + innerCol${i?", batchIndices":""});
    }
  }
  kStart = kStart + tileInner;
  workgroupBarrier();

  // Compute acc values for a single thread.
  var BCached : array<${r}, colPerThread>;
  for (var k = 0; k < tileInner; k = k + 1) {
    for (var inner = 0; inner < colPerThread; inner = inner + 1) {
      BCached[inner] = mm_Bsub[k][tileCol + inner];
    }

    for (var innerRow = 0; innerRow < rowPerThread; innerRow = innerRow + 1) {
      ${Tu(a)}
      for (var innerCol = 0; innerCol < colPerThread; innerCol = innerCol + 1) {
        acc[innerRow][innerCol] = acc[innerRow][innerCol] + ACached * BCached[innerCol];
      }
    }
  }

  workgroupBarrier();
}

for (var innerRow = 0; innerRow < rowPerThread; innerRow = innerRow + 1) {
  for (var innerCol = 0; innerCol < colPerThread; innerCol = innerCol + 1) {
    mm_write(batch, globalRow + innerRow, globalCol + innerCol,
        acc[innerRow][innerCol]);
  }
}
`;return`
  var<workgroup> mm_Asub : array<array<${r}, ${m}>, ${g}>;
  var<workgroup> mm_Bsub : array<array<${r}, ${h}>, ${s}>;
  const rowPerThread = ${e[1]};
  const colPerThread = ${e[0]};
  const tileInner = ${s};

@compute @workgroup_size(${t[0]}, ${t[1]}, ${t[2]})
fn main(@builtin(local_invocation_id) localId : vec3<u32>,
        @builtin(global_invocation_id) globalId : vec3<u32>,
        @builtin(workgroup_id) workgroupId : vec3<u32>) {
    let batch = ${n?"0":"i32(globalId.z)"};
    ${i?`let batchIndices = ${i.offsetToIndices("u32(batch)")};`:""}
    let num_tiles = ${n?`${Math.ceil(u/s)}`:"(uniforms.dim_inner - 1) / tileInner + 1"};
    var kStart = ${n?`i32(globalId.z) * ${u}`:"0"};

    var acc : array<array<${r}, colPerThread>, rowPerThread>;
    ${S}
  }
`},Iu=(e,t,r,i,a=!1)=>{let[s,n,u,l]=i,p=Te(i[0].type.tensor);return`
    fn mm_readA(batch: i32, row: i32, colIn: i32, batchIndices: ${s.type.indices}) -> ${Ee(e,p)} {
      var value = ${Ee(e,p)}(0.0);
      let col = colIn * ${e};
      if(row < uniforms.dim_a_outer && col < uniforms.dim_inner)
      {
        var aIndices: ${n.type.indices};
        ${dr("aIndices",n,n.rank-2,s.rank,"batchIndices")}
        ${n.indicesSet("aIndices",n.rank-2,"u32(row)")}
        ${n.indicesSet("aIndices",n.rank-1,"u32(colIn)")}
        value = ${n.getByIndices("aIndices")};
      }
      return value;
    }

    fn mm_readB(batch: i32, row: i32, colIn: i32, batchIndices: ${s.type.indices}) -> ${Ee(e,p)} {
      var value = ${Ee(e,p)}(0.0);
      let col = colIn * ${e};
      if(row < uniforms.dim_inner && col < uniforms.dim_b_outer)
      {
        var bIndices: ${u.type.indices};
        ${dr("bIndices",u,u.rank-2,s.rank,"batchIndices")}
        ${u.indicesSet("bIndices",u.rank-2,"u32(row)")}
        ${u.indicesSet("bIndices",u.rank-1,"u32(colIn)")}
        value = ${u.getByIndices("bIndices")};
      }
      return value;
    }

    fn mm_write(batch: i32, row: i32, colIn: i32, valueIn: ${Ee(e,p)}) {
      let col = colIn * ${e};
      if (row < uniforms.dim_a_outer && col < uniforms.dim_b_outer) {
        var value = valueIn;
        let coords = vec3<i32>(batch, row, colIn);
        ${t?`value = value + ${a?"bias[colIn]":`${Ee(e,p)}(bias[row])`};`:""}
        ${r}
        ${l.setByIndices("vec3<u32>(coords)","value")}
      }
    }
    `},Fr=(e,t,r,i,a=!1,s)=>{let n=e[0].dims,u=e[1].dims,l=n.slice(0,-2),p=u.slice(0,-2),h=i?i.slice(0,-2):r.slice(0,-2),m=R.size(h),g=n[n.length-2],y=n[n.length-1],_=u[u.length-1],b=y%4===0&&_%4===0,S=g<=8?[4,1,1]:[4,4,1],v=[8,8,1],w=[Math.ceil(_/v[0]/S[0]),Math.ceil(g/v[1]/S[1]),Math.ceil(m/v[2]/S[2])],I=b?4:1,k=[...l,g,y/I],E=k.length,A=[...p,y,_/I],C=A.length,x=[m,g,_/I],D=[{type:6,data:g},{type:6,data:_},{type:6,data:y}];Rt(t,D),D.push(...ee(h,k,A));let M=["rank","rank"],P=e.length>2;P&&(D.push(...ee(e[2].dims)),M.push("rank")),D.push(...ee(x));let K=Z=>{let O=h.length,G=Wa("batchDims",e[0].dataType,O,1),F=Te(e[0].dataType),Y=N("a",e[0].dataType,E,I),he=N("b",e[1].dataType,C,I),V=Q("result",e[0].dataType,x.length,I),se=[Y,he];if(P){let me=a?I:1;se.push(N("bias",e[2].dataType,e[2].dims.length,me))}let q=[{name:"dim_a_outer",type:"i32"},{name:"dim_b_outer",type:"i32"},{name:"dim_inner",type:"i32"}];Bt(t,q);let H=Te(V.type.tensor),X=Ot(t,V.type.value,H),L=Iu(I,P,X,[G,Y,he,V],a);return`
  ${Z.registerUniforms(q).registerInternalVariables(G).declareVariables(...se,V)}
  ${L}
  ${b?xa(S,v,F,G):Sa(S,v,F,G)}
                   `};return{name:"MatMul",shaderCache:{hint:`${S};${t.activation};${b};${a}`,inputDependencies:M},getRunData:()=>({outputs:[{dims:s?s(r):r,dataType:e[0].dataType}],dispatchGroup:{x:w[0],y:w[1],z:w[2]},programUniforms:D}),getShaderSource:K}}}),Eu,Wc,u0=U(()=>{te(),ot(),ae(),Mt(),ja(),o0(),Xa(),Eu=(e,t,r,i,a=!1,s,n=4,u=4,l=4,p="f32")=>{let h=D=>{switch(D){case 1:return"resData = x[xIndex];";case 3:return`resData = vec3<${p}>(x[xIndex], x[xIndex + 1], x[xIndex + 2]);`;case 4:return"resData = x[xIndex / 4];";default:throw new Error(`innerElementSize ${D} is not supported.`)}},m=D=>{switch(D){case 1:return"return w[row * i32(uniforms.w_shape[3]) + colIn];";case 4:return"return w[row * i32(uniforms.w_shape[3]) / 4 + colIn];";default:throw new Error(`innerElementSize ${D} is not supported.`)}},g=e?`
    let coord = vec4<i32>(batch, xRow, xCol, xCh);
    `:`
    let coord = vec4<i32>(batch, xCh, xRow, xCol);
    `,y=e?`
    let coords = vec4<i32>(
      batch,
      row / outWidth,
      row % outWidth,
      col);
    `:`
    let coords = vec4<i32>(
      batch,
      row,
      col / outWidth,
      col % outWidth);
    `,_=e?"i32(uniforms.x_shape[1])":"i32(uniforms.x_shape[2])",b=e?"i32(uniforms.x_shape[2])":"i32(uniforms.x_shape[3])",S=e?"row":"col",v=e?"col":"row",w=`
    let inChannels = i32(uniforms.w_shape[2]);
    let outWidth = ${e?"i32(uniforms.result_shape[2])":"i32(uniforms.result_shape[3])"};
    let outRow = ${S} / outWidth;
    let outCol = ${S} % outWidth;

    let WRow = ${v} / (i32(uniforms.w_shape[1]) * inChannels);
    let WCol = ${v} / inChannels % i32(uniforms.w_shape[1]);
    let xRow = outRow * uniforms.stride[0] + uniforms.dilation[0] * WRow - uniforms.pad[0];
    let xCol = outCol * uniforms.stride[1] + uniforms.dilation[1] * WCol - uniforms.pad[1];
    let xCh = ${v} % inChannels;
    var resData = ${Ee(n,p)}(0.0);
    // The bounds checking is always needed since we use it to pad zero for
    // the 'same' padding type.
    if (xRow >= 0 && xRow < ${_} && xCol >= 0 && xCol < ${b}) {
      ${g}
      let xIndex = getIndexFromCoords4D(coord, vec4<i32>(uniforms.x_shape));
      ${h(n)}
    }
    return resData;`,I=e?t&&i?`
    let col = colIn * ${n};
    ${w}`:`
    let col = colIn * ${n};
    if (row < uniforms.dim_a_outer && col < uniforms.dim_inner) {
      ${w}
    }
    return ${Ee(n,p)}(0.0);`:i&&r?`
    let col = colIn * ${n};
    ${w}`:`
    let col = colIn * ${n};
    if (row < uniforms.dim_inner && col < uniforms.dim_b_outer) {
      ${w}
    }
    return ${Ee(n,p)}(0.0);`,k=e?i&&r?m(u):`
    let col = colIn * ${u};
    if (row < uniforms.dim_inner && col < uniforms.dim_b_outer) {
      ${m(u)}
    }
    return ${Ee(u,p)}(0.0);`:`
    let col = colIn * ${u};
    if (row < uniforms.dim_inner && col < uniforms.dim_a_outer) {
      ${m(u)}
    }
    return ${Ee(u,p)}(0.0);`,E=Ee(l,p),A=Ee(e?n:u,p),C=Ee(e?u:n,p),x=Ot(s,E,p);return`
    fn mm_readA(batch: i32, row : i32, colIn : i32) -> ${A} {
      ${e?I:k}
    }

    fn mm_readB(batch: i32, row : i32, colIn : i32) -> ${C} {
      ${e?k:I}
    }

    fn mm_write(batch: i32, row : i32, colIn : i32, valueIn : ${E}) {
      let col = colIn * ${l};
      if (row < uniforms.dim_a_outer && col < uniforms.dim_b_outer)
      {
      var value = valueIn;
      let outWidth = ${e?"i32(uniforms.result_shape[2])":"i32(uniforms.result_shape[3])"};
      ${y}
      ${qc(a)}
      ${x}
      setOutputAtCoords(coords[0], coords[1], coords[2], coords[3], value);
      }
    }`},Wc=(e,t,r,i,a,s,n,u,l)=>{let p=t.format==="NHWC",h=p?e[0].dims[3]:e[0].dims[1],m=r[0],g=p?r[2]:r[3],y=p?r[1]:r[2],_=p?r[3]:r[1],b=p&&(h%4===0||h%3===0)&&_%4===0,S=p?_:g*y,v=p?g*y:_,w=[8,8,1],I=i<=8?[4,1,1]:[4,4,1],k=[Math.ceil(S/w[0]/I[0]),Math.ceil(v/w[1]/I[1]),Math.ceil(m/w[2]/I[2])];de("verbose",()=>`[conv2d_mm_webgpu] dispatch = ${k}`);let E=b?p&&h%4!==0?3:4:1,A=w[1]*I[1],C=w[0]*I[0],x=Math.max(w[0]*E,w[1]),D=i%A===0,M=a%C===0,P=s%x===0,K=b?[E,4,4]:[1,1,1],Z=[{type:6,data:i},{type:6,data:a},{type:6,data:s},{type:6,data:[t.pads[0],t.pads[1]]},{type:6,data:t.strides},{type:6,data:t.dilations}];Rt(t,Z),Z.push(...ee(e[0].dims,e[1].dims));let O=["rank","rank"];n&&(Z.push(...ee(e[2].dims)),O.push("rank")),Z.push(...ee(r));let G=F=>{let Y=[{name:"dim_a_outer",type:"i32"},{name:"dim_b_outer",type:"i32"},{name:"dim_inner",type:"i32"},{name:"pad",type:"i32",length:2},{name:"stride",type:"i32",length:2},{name:"dilation",type:"i32",length:2}];Bt(t,Y);let he=b?4:1,V=Te(e[0].dataType),se=`
      fn setOutputAtIndex(flatIndex : i32, value : ${b?`vec4<${V}>`:V}) {
        result[flatIndex] = ${b?`vec4<${V}>`:V}(value);
      }
      fn setOutputAtCoords(d0 : i32, d1 : i32, d2 : i32, d3 : i32, value : ${b?`vec4<${V}>`:V}) {
        let flatIndex = getOutputIndexFromCoords(vec4<i32>(d0, d1, d2, d3));
        setOutputAtIndex(flatIndex ${b?"/ 4":""}, value);
      }`,q=N("x",e[0].dataType,e[0].dims.length,E===3?1:E),H=N("w",e[1].dataType,e[1].dims.length,he),X=[q,H],L=Q("result",e[0].dataType,r.length,he);if(n){let me=N("bias",e[2].dataType,e[2].dims.length,he);X.push(me),se+=`
        fn getBiasByOutputCoords(coords : vec4<i32>) -> ${b?`vec4<${V}>`:V} {
          return bias[coords.${p?"w":"y"}${b?"/ 4":""}];
        }`}return`
        ${Lc("uniforms.result_strides")}
        //struct Uniforms { xShape : vec4<i32>, wShape : vec4<i32>, outShape : vec4<i32>,
        //  outShapeStrides: vec3<i32>, filterDims : vec2<i32>, pad : vec2<i32>, stride : vec2<i32>,
        //  dilation : vec2<i32>, dimAOuter : i32, dimBOuter : i32, dimInner : i32 };
        ${F.registerUniforms(Y).declareVariables(...X,L)}
        ${se}
        ${Eu(p,D,M,P,n,t,K[0],K[1],K[2],V)}
        ${b?xa(I,w,V,void 0,!p,x):Sa(I,w,V,void 0,!p,x,!1,void 0,u)}`};return{name:"Conv2DMatMul",shaderCache:{hint:`${t.cacheKey};${E};${b};${D};${M};${P};${A};${C};${x}`,inputDependencies:O},getRunData:()=>({outputs:[{dims:l?l(r):r,dataType:e[0].dataType}],dispatchGroup:{x:k[0],y:k[1],z:k[2]},programUniforms:Z}),getShaderSource:G}}}),zu,Li,er,Cu,Wi,Au,Vc,Gc,l0=U(()=>{te(),ot(),ie(),ae(),Mt(),ja(),zu=e=>{let t=1;for(let r=0;r<e.length;r++)t*=e[r];return t},Li=e=>typeof e=="number"?[e,e,e]:e,er=(e,t)=>t<=1?e:e+(e-1)*(t-1),Cu=(e,t,r,i=1)=>{let a=er(t,i);return Math.floor((e[0]*(r-1)-r+a)/2)},Wi=(e,t,r,i,a)=>{a==null&&(a=Cu(e,t[0],i[0]));let s=[0,0,0,r];for(let n=0;n<3;n++)e[n]+2*a>=t[n]&&(s[n]=Math.trunc((e[n]-t[n]+2*a)/i[n]+1));return s},Au=(e,t,r,i,a,s,n,u,l,p)=>{let h,m,g,y;if(e==="VALID"&&(e=0),typeof e=="number"){h={top:e,bottom:e,left:e,right:e,front:e,back:e};let _=Wi([t,r,i,1],[u,l,p],1,[a,s,n],e);m=_[0],g=_[1],y=_[2]}else if(Array.isArray(e)){if(!e.every((b,S,v)=>b===v[0]))throw Error(`Unsupported padding parameter: ${e}`);h={top:e[0],bottom:e[1],left:e[2],right:e[3],front:e[4],back:e[5]};let _=Wi([t,r,i,1],[u,l,p],1,[a,s,n],e[0]);m=_[0],g=_[1],y=_[2]}else if(e==="SAME_UPPER"){m=Math.ceil(t/a),g=Math.ceil(r/s),y=Math.ceil(i/n);let _=(m-1)*a+u-t,b=(g-1)*s+l-r,S=(y-1)*n+p-i,v=Math.floor(_/2),w=_-v,I=Math.floor(b/2),k=b-I,E=Math.floor(S/2),A=S-E;h={top:I,bottom:k,left:E,right:A,front:v,back:w}}else throw Error(`Unknown padding parameter: ${e}`);return{padInfo:h,outDepth:m,outHeight:g,outWidth:y}},Vc=(e,t,r,i,a,s=!1,n="channelsLast")=>{let u,l,p,h,m;if(n==="channelsLast")[u,l,p,h,m]=e;else if(n==="channelsFirst")[u,m,l,p,h]=e;else throw new Error(`Unknown dataFormat ${n}`);let[g,,y,_,b]=t,[S,v,w]=Li(r),[I,k,E]=Li(i),A=er(y,I),C=er(_,k),x=er(b,E),{padInfo:D,outDepth:M,outHeight:P,outWidth:K}=Au(a,l,p,h,S,v,w,A,C,x),Z=s?g*m:g,O=[0,0,0,0,0];return n==="channelsFirst"?O=[u,Z,M,P,K]:n==="channelsLast"&&(O=[u,M,P,K,Z]),{batchSize:u,dataFormat:n,inDepth:l,inHeight:p,inWidth:h,inChannels:m,outDepth:M,outHeight:P,outWidth:K,outChannels:Z,padInfo:D,strideDepth:S,strideHeight:v,strideWidth:w,filterDepth:y,filterHeight:_,filterWidth:b,effectiveFilterDepth:A,effectiveFilterHeight:C,effectiveFilterWidth:x,dilationDepth:I,dilationHeight:k,dilationWidth:E,inShape:e,outShape:O,filterShape:t}},Gc=(e,t,r,i,a,s)=>{let n=s==="channelsLast";n?e[0].dims[3]:e[0].dims[1];let u=[64,1,1],l={x:r.map((S,v)=>v)},p=[Math.ceil(zu(l.x.map(S=>r[S]))/u[0]),1,1];de("verbose",()=>`[conv3d_naive_webgpu] dispatch = ${p}`);let h=1,m=R.size(r),g=[{type:12,data:m},{type:12,data:i},{type:12,data:a},{type:12,data:t.strides},{type:12,data:t.dilations}];Rt(t,g),g.push(...ee(e[0].dims,e[1].dims));let y=["rank","rank"],_=e.length===3;_&&(g.push(...ee(e[2].dims)),y.push("rank")),g.push(...ee(r));let b=S=>{let v=[{name:"output_size",type:"u32"},{name:"filter_dims",type:"u32",length:i.length},{name:"pads",type:"u32",length:a.length},{name:"strides",type:"u32",length:t.strides.length},{name:"dilations",type:"u32",length:t.dilations.length}];Bt(t,v);let w=1,I=Te(e[0].dataType),k=N("x",e[0].dataType,e[0].dims.length,h),E=N("W",e[1].dataType,e[1].dims.length,w),A=[k,E],C=Q("result",e[0].dataType,r.length,w),x="";if(_){let P=N("bias",e[2].dataType,e[2].dims.length,w);A.push(P),x+=`
        fn getBiasByOutputCoords(coords : array<u32, 5>) -> ${I} {
          return bias[${n?J("coords",4,5):J("coords",1,5)}];
        }`}let D=Ee(h,I),M=Ot(t,D,I);return`
            ${x}
            fn getX(d0 : u32, d1 : u32, d2 : u32, d3 : u32, d4 : u32) -> f32 {
              let aIndices = array<u32, 5>(d0, d1, d2, d3, d4);
              return ${k.getByIndices("aIndices")};
            }
            fn getW(d0 : u32, d1 : u32, d2 : u32, d3 : u32, d4 : u32) -> f32 {
              let aIndices = array<u32, 5>(d0, d1, d2, d3, d4);
              return ${E.getByIndices("aIndices")};
            }
          ${S.registerUniforms(v).declareVariables(...A,C)}
          ${S.mainStart()}
          ${S.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.output_size")}
              let coords = ${C.offsetToIndices("global_idx")};
              let batch = ${J("coords",0,k.rank)};
              let d2 = ${n?J("coords",k.rank-1,k.rank):J("coords",1,k.rank)};
              let xFRCCorner = vec3<u32>(${n?J("coords",1,k.rank):J("coords",2,k.rank)},
              ${n?J("coords",2,k.rank):J("coords",3,k.rank)},
              ${n?J("coords",3,k.rank):J("coords",4,k.rank)}) * uniforms.strides - uniforms.pads;
              let xFCorner = xFRCCorner.x;
              let xRCorner = xFRCCorner.y;
              let xCCorner = xFRCCorner.z;
              let xShapeY = ${n?J("uniforms.x_shape",1,k.rank):J("uniforms.x_shape",2,k.rank)};
              let xShapeZ = ${n?J("uniforms.x_shape",2,k.rank):J("uniforms.x_shape",3,k.rank)};
              let xShapeW = ${n?J("uniforms.x_shape",3,k.rank):J("uniforms.x_shape",4,k.rank)};
              let xShapeU = ${n?J("uniforms.x_shape",4,k.rank):J("uniforms.x_shape",1,k.rank)};
              let inputDepthNearestVec4 = (xShapeU / 4) * 4;
              let inputDepthVec4Remainder = xShapeU % 4;

              var value = 0.0;
              for (var wF = 0u; wF < uniforms.filter_dims[0]; wF++) {
                let xF = xFCorner + wF * uniforms.dilations[0];
                if (xF < 0 || xF >= xShapeY) {
                  continue;
                }

                for (var wR = 0u; wR < uniforms.filter_dims[1]; wR++) {
                  let xR = xRCorner + wR * uniforms.dilations[1];
                  if (xR < 0 || xR >= xShapeZ) {
                    continue;
                  }

                  for (var wC = 0u; wC < uniforms.filter_dims[2]; wC++) {
                    let xC = xCCorner + wC * uniforms.dilations[2];
                    if (xC < 0 || xC >= xShapeW) {
                      continue;
                    }

                    for (var d1 = 0u; d1 < inputDepthNearestVec4; d1 += 4) {
                      ${n?`let xValues = vec4<f32>(
                               getX(batch, xF, xR, xC, d1),
                               getX(batch, xF, xR, xC, d1 + 1),
                               getX(batch, xF, xR, xC, d1 + 2),
                               getX(batch, xF, xR, xC, d1 + 3));
                            `:`let xValues = vec4<f32>(
                               getX(batch, d1, xF, xR, xC),
                               getX(batch, d1 + 1, xF, xR, xC),
                               getX(batch, d1 + 2, xF, xR, xC),
                               getX(batch, d1 + 3, xF, xR, xC));
                            `}
                            let wValues = vec4<f32>(
                              getW(d2, d1, wF, wR, wC),
                              getW(d2, d1 + 1, wF, wR, wC),
                              getW(d2, d1 + 2, wF, wR, wC),
                              getW(d2, d1 + 3, wF, wR, wC));
                      value += dot(xValues, wValues);
                    }
                    if (inputDepthVec4Remainder == 1) {
                        ${n?`value += getX(batch, xF, xR, xC, inputDepthNearestVec4)
                          * getW(d2, inputDepthNearestVec4, wF, wR, wC);`:`value += getX(batch, inputDepthNearestVec4, xF, xR, xC)
                          * getW(d2, inputDepthNearestVec4, wF, wR, wC);`}
                    } else if (inputDepthVec4Remainder == 2) {
                      ${n?`let xValues = vec2<f32>(
                        getX(batch, xF, xR, xC, inputDepthNearestVec4),
                        getX(batch, xF, xR, xC, inputDepthNearestVec4 + 1));
                      `:`let xValues = vec2<f32>(
                        getX(batch, inputDepthNearestVec4, xF, xR, xC),
                        getX(batch, inputDepthNearestVec4 + 1, xF, xR, xC));
                    `}
                    let wValues = vec2<f32>(
                      getW(d2, inputDepthNearestVec4, wF, wR, wC),
                      getW(d2, inputDepthNearestVec4 + 1, wF, wR, wC));
                      value += dot(xValues, wValues);
                    } else if (inputDepthVec4Remainder == 3) {
                      ${n?`let xValues = vec3<f32>(
                        getX(batch, xF, xR, xC, inputDepthNearestVec4),
                        getX(batch, xF, xR, xC, inputDepthNearestVec4 + 1),
                        getX(batch, xF, xR, xC, inputDepthNearestVec4 + 2));
                      `:`let xValues = vec3<f32>(
                        getX(batch, inputDepthNearestVec4, xF, xR, xC),
                        getX(batch, inputDepthNearestVec4 + 1, xF, xR, xC),
                        getX(batch, inputDepthNearestVec4 + 2, xF, xR, xC));
                    `}
                    let wValues = vec3<f32>(
                      getW(d2, inputDepthNearestVec4, wF, wR, wC),
                      getW(d2, inputDepthNearestVec4 + 1, wF, wR, wC),
                      getW(d2, inputDepthNearestVec4 + 2, wF, wR, wC));
                      value += dot(xValues, wValues);
                    }
                  }
                }
              }
              ${_?"value = value + getBiasByOutputCoords(coords)":""};
              ${M}
              result[global_idx] = f32(value);
          }`};return{name:"Conv3DNaive",shaderCache:{hint:`${t.cacheKey};${n};${h};${_}`,inputDependencies:y},getRunData:()=>({outputs:[{dims:r,dataType:e[0].dataType}],dispatchGroup:{x:p[0],y:p[1],z:p[2]},programUniforms:g}),getShaderSource:b}}}),Hc,Fc,d0=U(()=>{te(),ie(),ae(),Mt(),Hc=(e,t,r,i)=>{let a=e.length>2,s=a?"value += b[output_channel];":"",n=e[0].dims,u=e[1].dims,l=t.format==="NHWC",p=l?r[3]:r[1],h=p/t.group,m=l&&h>=4?ve(p):1,g=R.size(r)/m,y=[{type:12,data:g},{type:12,data:t.dilations},{type:12,data:[t.strides[0],t.strides[1]]},{type:12,data:[t.pads[0],t.pads[1]]},{type:12,data:h}];Rt(t,y),y.push(...ee(n,[u[0],u[1],u[2],u[3]/m]));let _=a?["rank","rank","rank"]:["rank","rank"];y.push(...ee([r[0],r[1],r[2],r[3]/m]));let b=S=>{let v=Q("output",e[0].dataType,r.length,m),w=Te(v.type.tensor),I=Ot(t,v.type.value,w),k=N("x",e[0].dataType,n.length),E=N("w",e[1].dataType,u.length,m),A=[k,E];a&&A.push(N("b",e[2].dataType,e[2].dims,m));let C=[{name:"output_size",type:"u32"},{name:"dilations",type:"u32",length:t.dilations.length},{name:"strides",type:"u32",length:2},{name:"pads",type:"u32",length:2},{name:"output_channels_per_group",type:"u32"}];Bt(t,C);let x=l?`
      for (var wHeight: u32 = 0u; wHeight < uniforms.w_shape[0]; wHeight++) {
        let xHeight = xRCCorner.x + wHeight * uniforms.dilations[0];

        if (xHeight < 0u || xHeight >= uniforms.x_shape[1]) {
          continue;
        }

        for (var wWidth: u32 = 0u; wWidth < uniforms.w_shape[1]; wWidth++) {
          let xWidth = xRCCorner.y + wWidth * uniforms.dilations[1];
          if (xWidth < 0u || xWidth >= uniforms.x_shape[2]) {
            continue;
          }

          for (var wInChannel: u32 = 0u; wInChannel < uniforms.w_shape[2]; wInChannel++) {
            let input_channel = in_channel_offset + wInChannel;
            let xVal = ${k.get("batch","xHeight","xWidth","input_channel")};
            let wVal = ${E.get("wHeight","wWidth","wInChannel","output_channel")};
            value += xVal * wVal;
          }
        }
      }
      `:`
      for (var wInChannel: u32 = 0u; wInChannel < uniforms.w_shape[1]; wInChannel++) {
        let input_channel = in_channel_offset + wInChannel;
        for (var wHeight: u32 = 0u; wHeight < uniforms.w_shape[2]; wHeight++) {
          let xHeight = xRCCorner.x + wHeight * uniforms.dilations[0];

          if (xHeight < 0u || xHeight >= uniforms.x_shape[2]) {
            continue;
          }

          for (var wWidth: u32 = 0u; wWidth < uniforms.w_shape[3]; wWidth++) {
            let xWidth = xRCCorner.y + wWidth * uniforms.dilations[1];
            if (xWidth < 0u || xWidth >= uniforms.x_shape[3]) {
              continue;
            }

            let xVal = ${k.get("batch","input_channel","xHeight","xWidth")};
            let wVal = ${E.get("output_channel","wInChannel","wHeight","wWidth")};
            value += xVal * wVal;
          }
        }
      }
      `;return`
  ${S.registerUniforms(C).declareVariables(...A,v)}

  ${S.mainStart()}
    ${S.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.output_size")}

    let outputIndices = ${v.offsetToIndices("global_idx")};
    let batch: u32 = outputIndices[0];
    let output_channel: u32 = outputIndices[${l?3:1}];
    let xRCCorner: vec2<u32> = vec2<u32>(outputIndices[${l?1:2}], outputIndices[${l?2:3}]) * uniforms.strides - uniforms.pads;
    let group_id: u32 = output_channel * ${m} / uniforms.output_channels_per_group;
    var in_channel_offset = group_id * uniforms.w_shape[${l?2:1}];

    var value: ${v.type.value} = ${v.type.value}(0);
    ${x}
    ${s}
    ${I}
    ${v.setByOffset("global_idx","value")}
  }`};return{name:"GroupedConv",shaderCache:{hint:`${t.cacheKey}_${m}`,inputDependencies:_},getRunData:()=>({outputs:[{dims:i?i(r):r,dataType:e[0].dataType}],dispatchGroup:{x:Math.ceil(g/64)},programUniforms:y}),getShaderSource:b}},Fc=(e,t,r,i)=>{let a=e.length>2,s=ve(r[3]),n=ve(r[2]),u=R.size(r)/s/n,l=[e[0].dims[0],e[0].dims[1],e[0].dims[2],e[0].dims[3]/s],p=[e[1].dims[0],e[1].dims[1],e[1].dims[2],e[1].dims[3]/s],h=[r[0],r[1],r[2],r[3]/s],m=[{type:12,data:u},{type:6,data:[t.strides[0],t.strides[1]]},{type:6,data:[t.pads[0],t.pads[1]]}];Rt(t,m),m.push(...ee(l,p,h));let g=(n-1)*t.strides[1]+p[1],y=_=>{let b=Q("output",e[0].dataType,h.length,s),S=Te(b.type.tensor),v=Ot(t,b.type.value,S),w=N("x",e[0].dataType,l.length,s),I=N("w",e[1].dataType,p.length,s),k=[w,I];a&&k.push(N("b",e[2].dataType,e[2].dims,s));let E=a?"value += b[output_channel];":"",A=[{name:"output_size",type:"u32"},{name:"strides",type:"i32",length:2},{name:"pads",type:"i32",length:2}];return Bt(t,A),`
  ${_.registerUniforms(A).declareVariables(...k,b)}
  ${_.mainStart()}
    ${_.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.output_size")}
    let width0 = uniforms.output_shape[3];
    let output_channel = global_idx % width0;
    var index1 = global_idx / width0;
    let width1 = uniforms.output_shape[2] / ${n}u;
    let col = (index1 % width1) * ${n}u;
    index1 = index1 / width1;
    let row = index1 % uniforms.output_shape[1];
    let batch = index1 / uniforms.output_shape[1];

    let x_corner = vec2<i32>(i32(row), i32(col)) * uniforms.strides - uniforms.pads;

    var x_vals: array<${w.type.value}, ${g}>;
    var values: array<${b.type.value}, ${n}>;
    let input_channel = output_channel;
    // Use constant instead of uniform can give better performance for w's height/width.
    for (var w_height: u32 = 0u; w_height < ${p[0]}; w_height++) {
      let x_height = x_corner.x + i32(w_height);
      if (x_height >= 0 && u32(x_height) < uniforms.x_shape[1]) {
        for (var i = 0; i < ${g}; i++) {
          let x_width = x_corner.y + i;
          if (x_width >= 0 && u32(x_width) < uniforms.x_shape[2]) {
            x_vals[i] = ${w.get("batch","u32(x_height)","u32(x_width)","input_channel")};
          } else {
            x_vals[i] = ${w.type.value}(0);
          }
        }
        for (var w_width: u32 = 0u; w_width < ${p[1]}; w_width++) {
          let w_val = ${I.get("w_height","w_width","0","output_channel")};
          for (var i = 0u; i < ${n}u; i++) {
            values[i] = fma(x_vals[i * u32(uniforms.strides[1]) + w_width], w_val, values[i]);
          }
        }
      }
    }

    for (var i = 0u; i < ${n}u; i++) {
      var value = values[i];
      ${E}
      ${v}
      ${b.set("batch","row","col + i","output_channel","value")};
    }
  }`};return{name:"GroupedConv-Vectorize",shaderCache:{hint:`${t.cacheKey};${s};${n};${g};${p[0]};${p[1]}`,inputDependencies:a?["rank","rank","type"]:["rank","rank"]},getRunData:()=>({outputs:[{dims:i?i(r):r,dataType:e[0].dataType}],dispatchGroup:{x:Math.ceil(u/64)},programUniforms:m}),getShaderSource:y}}}),Ou,Rr,Ru,Br,ka,Vi,Bu,Nu,Ta,p0=U(()=>{ie(),u0(),l0(),Xa(),d0(),Mt(),Za(),_t(),Ou=(e,t,r,i,a,s)=>{let n=e[0],u=e.slice(s?1:2,s?3:4),l=u.length,p=t[0],h=t.slice(2).map((g,y)=>g+(g-1)*(r[y]-1)),m=u.map((g,y)=>g+i[y]+i[y+l]).map((g,y)=>Math.floor((g-h[y]+a[y])/a[y]));return m.splice(0,0,n),m.splice(s?3:1,0,p),m},Rr=[2,3,1,0],Ru=(e,t)=>{if(!e||e.length!==2&&e.length!==3)throw new Error("Conv requires 2 or 3 inputs");if(e[0].dims.length>5)throw new Error("greater than 5D is not supported");if(e[0].dims.length!==e[1].dims.length)throw new Error("filter does not have same dimension as input");let r=e[0].dims[t.format==="NHWC"?e[0].dims.length-1:1],i=e[1].dims[1]*t.group;if(r!==i)throw new Error("FILTER_IN_CHANNEL should be equal to DATA_CHANNEL");if(e.length===3&&(e[2].dims.length!==1||e[1].dims[0]!==e[2].dims[0]))throw new Error("invalid bias");let a=e[0].dims.length-2;if(t.dilations.length!==a)throw new Error(`dilations should be ${a}D`);if(t.strides.length!==a)throw new Error(`strides should be ${a}D`);if(t.pads.length!==a*2)throw new Error(`pads should be ${a*2}D`);if(t.kernelShape.length!==0&&t.kernelShape.length!==e[1].dims.length-2)throw new Error("invalid kernel shape")},Br=(e,t)=>{let r=e.kernelShape.slice();r.length<t[1].dims.length-2&&r.push(...Array(t[1].dims.length-2-r.length).fill(0));for(let s=2;s<t[1].dims.length;++s)r[s-2]===0&&(r[s-2]=t[1].dims[s]);let i=e.pads.slice();Gr.adjustPadsBasedOnAutoPad(t[0].dims,e.strides,e.dilations,r,i,e.format==="NHWC",e.autoPad);let a=Object.assign({},e);return Object.assign(a,{kernelShape:r,pads:i}),a},ka=e=>{let t=Fa(e),r=e.format,i=["NOTSET","VALID","SAME_UPPER","SAME_LOWER"][e.auto_pad],a=e.dilations,s=e.group,n=e.kernel_shape,u=e.pads,l=e.strides,p=e.w_is_const();return{autoPad:i,format:r,dilations:a,group:s,kernelShape:n,pads:u,strides:l,wIsConst:p,...t,cacheKey:`${e.format};${t.activation};`}},Vi=(e,t,r,i)=>{var A,C,x;let a=r.format==="NHWC",s=Ou(t[0].dims,t[1].dims,r.dilations,r.pads,r.strides,a);if(r.group!==1){let D=[t[0]];if(a){let M=(A=e.kernelCustomData.wT)!=null?A:e.compute(Pe(t[1],Rr),{inputs:[1],outputs:[r.wIsConst?-2:-1]})[0];r.wIsConst&&!e.kernelCustomData.wT&&(e.kernelCustomData.wT=M),D.push(M)}else D.push(t[1]);t.length===3&&D.push(t[2]),!e.adapterInfo.isArchitecture("ampere")&&a&&t[1].dims[0]===r.group&&t[1].dims[1]===1&&r.dilations[0]===1&&r.dilations[1]===1?e.compute(Fc(D,r,s,i),{inputs:D}):e.compute(Hc(D,r,s,i),{inputs:D});return}let n=t.length===3,u=t[0].dims[a?1:2],l=t[0].dims[a?2:3],p=t[0].dims[a?3:1],h=t[1].dims[2],m=t[1].dims[3],g=s[a?1:2],y=s[a?2:3],_=s[a?3:1],b=a&&h===u&&m===l&&r.pads[0]===0&&r.pads[1]===0;if(b||h===1&&m===1&&r.dilations[0]===1&&r.dilations[1]===1&&r.strides[0]===1&&r.strides[1]===1&&r.pads[0]===0&&r.pads[1]===0){let D=s[0],M,P,K,Z=[];if(a){let F=(C=e.kernelCustomData.wT)!=null?C:e.compute(Pe(t[1],Rr),{inputs:[1],outputs:[r.wIsConst?-2:-1]})[0];if(r.wIsConst&&!e.kernelCustomData.wT&&(e.kernelCustomData.wT=F),b){let Y=u*l*p;M=t[0].reshape([1,D,Y]),P=F.reshape([1,Y,_]),K=[1,D,_]}else M=t[0].reshape([D,u*l,p]),P=F.reshape([1,p,_]),K=[D,g*y,_];Z.push(M),Z.push(P)}else M=t[0].reshape([D,p,u*l]),P=t[1].reshape([1,_,p]),K=[D,_,g*y],Z.push(P),Z.push(M);n&&Z.push(t[2]);let O=K[2],G=Z[0].dims[Z[0].dims.length-1];O<8&&G<8?e.compute(Ka(Z,r,s,K,a,i),{inputs:Z}):e.compute(Fr(Z,r,s,K,a,i),{inputs:Z});return}let S=!0,v=(x=e.kernelCustomData.wT)!=null?x:e.compute(Pe(t[1],Rr),{inputs:[1],outputs:[r.wIsConst?-2:-1]})[0];r.wIsConst&&!e.kernelCustomData.wT&&(e.kernelCustomData.wT=v);let w=[t[0],v];n&&w.push(t[2]);let I=a?g*y:_,k=a?_:g*y,E=h*m*p;e.compute(Wc(w,r,s,I,k,E,n,S,i),{inputs:w})},Bu=(e,t)=>{let r=t.format==="NHWC",i=[e.inputs[0].reshape(r?[e.inputs[0].dims[0],1,e.inputs[0].dims[1],e.inputs[0].dims[2]]:[e.inputs[0].dims[0],e.inputs[0].dims[1],1,e.inputs[0].dims[2]]),e.inputs[1].reshape([e.inputs[1].dims[0],e.inputs[1].dims[1],1,e.inputs[1].dims[2]])];e.inputs.length===3&&i.push(e.inputs[2]);let a=[0,t.pads[0],0,t.pads[1]],s=[1].concat(t.strides),n=[1].concat(t.dilations),u=[1].concat(t.kernelShape),l=Br({...t,pads:a,strides:s,dilations:n,kernelShape:u},i);Vi(e,i,l,p=>r?[p[0],p[2],p[3]]:[p[0],p[1],p[3]])},Nu=(e,t,r)=>{let i=r.format==="NHWC"?"channelsLast":"channelsFirst",a=Br(r,t),s=r.autoPad==="NOTSET"?r.pads:r.autoPad,n=Vc(t[0].dims,t[1].dims,r.strides,r.dilations,s,!1,i);e.compute(Gc(t,a,n.outShape,[n.filterDepth,n.filterHeight,n.filterWidth],[n.padInfo.front,n.padInfo.top,n.padInfo.left],i))},Ta=(e,t)=>{if(Ru(e.inputs,t),e.inputs[0].dims.length===3)Bu(e,t);else if(e.inputs[0].dims.length===5)Nu(e,e.inputs,t);else{let r=Br(t,e.inputs);Vi(e,e.inputs,r)}}}),jc,c0=U(()=>{te(),ot(),ie(),ae(),jc=(e,t,r)=>{let i=e.length>2,a=t.outputShape,s=t.format==="NHWC",n=t.group,u=e[1].dims,l=u[2]/n,p=u[3],h=s?ve(l):1,m=s&&p===1&&l>=4,g=m?Math.floor(l/4)*4:Math.floor(l/h)*h,y=l-g,_=s?ve(p):1,b=s?p===1?h:_:1,S=R.size(a)/_,v=[Math.ceil(S/64),1,1];de("verbose",()=>`[conv2d_backprop_webgpu] dispatch = ${v}`);let w=["rank","rank"],I=[t.strides[0],t.strides[1]],k=[t.kernelShape[s?1:2],t.kernelShape[s?2:3]],E=[t.dilations[0],t.dilations[1]],A=[k[0]+(t.dilations[0]<=1?0:(t.kernelShape[s?1:2]-1)*(t.dilations[0]-1)),k[1]+(t.dilations[1]<=1?0:(t.kernelShape[s?2:3]-1)*(t.dilations[1]-1))],C=[A[0]-1-Math.floor((t.pads[0]+t.pads[2])/2),A[1]-1-Math.floor((t.pads[1]+t.pads[3])/2)],x=[{type:12,data:S},{type:12,data:I},{type:12,data:k},{type:12,data:E},{type:12,data:A},{type:6,data:C},{type:12,data:g},{type:12,data:l},{type:12,data:p},...ee(e[0].dims,e[1].dims)];i&&(x.push(...ee(e[2].dims)),w.push("rank")),x.push(...ee(a));let D=M=>{let P=[{name:"output_size",type:"u32"},{name:"strides",type:"u32",length:I.length},{name:"filter_dims",type:"u32",length:k.length},{name:"dilations",type:"u32",length:k.length},{name:"effective_filter_dims",type:"u32",length:A.length},{name:"pads",type:"i32",length:C.length},{name:"input_channels_per_group_int",type:"u32"},{name:"input_channels_per_group",type:"u32"},{name:"output_channels_per_group",type:"u32"}],K=Te(e[0].dataType),Z=s?1:2,O=s?2:3,G=s?3:1,F=N("W",e[1].dataType,e[1].dims.length,b),Y=N("Dy",e[0].dataType,e[0].dims.length,h),he=[Y,F];i&&he.push(N("bias",e[2].dataType,[a[G]].length,_));let V=Q("result",e[0].dataType,a.length,_),se=()=>{let X="";if(m)h===4?X+=`
        let xValue = ${Y.getByOffset("x_offset")};
        let wValue = ${F.getByOffset("w_offset")};
        dotProd = dotProd + dot(xValue, wValue);
        x_offset += 1u;
        w_offset += 1u;`:h===2?X+=`
          dotProd = dotProd + dot(vec4<${K}>(${Y.getByOffset("x_offset")}, ${Y.getByOffset("x_offset + 1u")}), vec4<${K}>(${F.getByOffset("w_offset")}, ${F.getByOffset("w_offset + 1u")}));
          x_offset += 2u;
          w_offset += 2u;`:h===1&&(X+=`
          dotProd = dotProd + dot(vec4<${K}>(${Y.getByOffset("x_offset")}, ${Y.getByOffset("x_offset + 1u")}, ${Y.getByOffset("x_offset + 2u")}, ${Y.getByOffset("x_offset + 3u")}), vec4<${K}>(${F.getByOffset("w_offset")}, ${F.getByOffset("w_offset + 1u")}, ${F.getByOffset("w_offset + 2u")}, ${F.getByOffset("w_offset + 3u")}));
          x_offset += 4u;
          w_offset += 4u;`);else if(X+=`
                  let xValue = ${s?Y.getByOffset(`${Y.indicesToOffset(`${Y.type.indices}(batch, idyR, idyC, inputChannel)`)} / ${h}`):Y.get("batch","inputChannel","idyR","idyC")};
        `,h===1)X+=`
          let w_offset = ${F.indicesToOffset(`${F.type.indices}(u32(wRPerm), u32(wCPerm), inputChannel, wOutChannel)`)};
          let wValue = ${F.getByOffset(`w_offset / ${b}`)};
          dotProd = dotProd + xValue * wValue;`;else for(let L=0;L<h;L++)X+=`
            let wValue${L} = ${F.getByOffset(`${F.indicesToOffset(`${F.type.indices}(u32(wRPerm), u32(wCPerm), inputChannel + ${L}, wOutChannel)`)} / ${b}`)};
            dotProd = dotProd + xValue[${L}] * wValue${L};`;return X},q=()=>{if(y===0)return"";if(!m)throw new Error(`packInputAs4 ${m} is not true.`);let X="";if(h===1){X+="dotProd = dotProd";for(let L=0;L<y;L++)X+=`
            + ${Y.getByOffset(`x_offset + ${L}`)} * ${F.getByOffset(`w_offset + ${L}`)}`;X+=";"}else if(h===2){if(y!==2)throw new Error(`Invalid inputChannelsRemainder ${y}.`);X+=`
          let xValue = ${Y.getByOffset("x_offset")};
          let wValue = ${F.getByOffset("w_offset")};
          dotProd = dotProd + dot(xValue, wValue);`}return X},H=`
            let outputIndices = ${V.offsetToIndices(`global_idx * ${_}`)};
            let batch = ${V.indicesGet("outputIndices",0)};
            let d1 = ${V.indicesGet("outputIndices",G)};
            let r = ${V.indicesGet("outputIndices",Z)};
            let c = ${V.indicesGet("outputIndices",O)};
            let dyCorner = vec2<i32>(i32(r), i32(c)) - uniforms.pads;
            let dyRCorner = dyCorner.x;
            let dyCCorner = dyCorner.y;
            let groupId = d1 / uniforms.output_channels_per_group;
            let wOutChannel = d1 - groupId * uniforms.output_channels_per_group;
            // Convolve dy(?, ?, d2) with w(:, :, d1, d2) to compute dx(xR, xC, d1).
            // ? = to be determined. : = across all values in that axis.
            var dotProd = ${V.type.value}(0.0);
            var wR: u32 = 0;
            if (uniforms.dilations.x == 1) {
              // Minimum wR >= 0 that satisfies (dyRCorner + wR) % (uniforms.strides.x) == 0
              wR = u32(((dyRCorner + i32(uniforms.strides.x) - 1) / i32(uniforms.strides.x)) * i32(uniforms.strides.x) - dyRCorner);
            }
            for (; wR < uniforms.effective_filter_dims.x; wR = wR + 1) {
              if (wR % uniforms.dilations.x != 0) {
                continue;
              }
              let dyR = (${K}(dyRCorner) + ${K}(wR)) / ${K}(uniforms.strides[0]);
              let wRPerm = uniforms.filter_dims.x - 1 - wR / uniforms.dilations.x;
              if (dyR < 0.0 || dyR >= ${K}(uniforms.Dy_shape[${Z}]) || fract(dyR) > 0.0 ||
                  wRPerm < 0) {
                continue;
              }
              let idyR: u32 = u32(dyR);
              var wC: u32 = 0;
              if (uniforms.dilations.y == 1) {
                // Minimum wC >= 0 that satisfies (dyCCorner + wC) % (uniforms.strides.y) == 0
                wC = u32(((dyCCorner + i32(uniforms.strides.y) - 1) / i32(uniforms.strides.y)) * i32(uniforms.strides.y) - dyCCorner);
              }
              for (; wC < uniforms.effective_filter_dims.y; wC = wC + 1) {
                if (wC % uniforms.dilations.y != 0) {
                  continue;
                }
                let dyC = (${K}(dyCCorner) + ${K}(wC)) / ${K}(uniforms.strides.y);
                let wCPerm = uniforms.filter_dims.y - 1 - wC / uniforms.dilations.y;
                if (dyC < 0.0 || dyC >= ${K}(uniforms.Dy_shape[${O}]) ||
                    fract(dyC) > 0.0 || wCPerm < 0) {
                  continue;
                }
                let idyC: u32 = u32(dyC);
                var inputChannel = groupId * uniforms.input_channels_per_group;
                ${m?`
                var x_offset = ${Y.indicesToOffset(`${Y.type.indices}(batch, idyR, idyC, inputChannel)`)} / ${h};
                var w_offset = ${F.indicesToOffset(`${F.type.indices}(wRPerm, wCPerm, inputChannel, wOutChannel)`)} / ${b};
                  `:""}
                for (var d2: u32 = 0; d2 < uniforms.input_channels_per_group_int; d2 = d2 + ${m?4:h}) {
                  ${se()}
                  inputChannel = inputChannel + ${m?4:h};
                }
                ${q()}
                wC = wC + uniforms.strides.y - 1;
              }
              wR = wR + uniforms.strides[0] - 1;
            }
            let value = dotProd${i?` + bias[d1 / ${_}]`:""};
            ${V.setByOffset("global_idx","value")};
          `;return`
    ${M.registerUniforms(P).declareVariables(...he,V)}
      ${M.mainStart()}
      ${M.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.output_size")};
    ${H}}`};return{name:"ConvTranspose2D",shaderCache:{hint:`${t.cacheKey};${h}${b}${_}${m}${y}`,inputDependencies:w},getRunData:()=>({dispatchGroup:{x:v[0],y:v[1],z:v[2]},outputs:[{dims:r?r(a):a,dataType:e[0].dataType}],programUniforms:x}),getShaderSource:D}}}),Mu,Du,Uu,Gi,Kc,Pu,Hi,qu,Zc,h0=U(()=>{c0(),Mt(),_t(),Mu=(e,t,r,i,a,s)=>(e-1)*t+r+(i-1)*a+1-s,Du=(e,t,r,i,a)=>{let s=Math.floor(e/2);t==="SAME_UPPER"?(r[i]=s,r[a]=e-s):t==="SAME_LOWER"&&(r[i]=e-s,r[a]=s)},Uu=(e,t,r,i,a,s,n,u,l,p)=>{let h=e.length-2,m=p.length===0;l.length<h&&l.push(...Array(h-l.length).fill(0));let g=e[0],y=t[u?3:1]*a;for(let _=0,b=e.length-h-(u?1:0);_<h;++_,++b){let S=e[b],v=m?S*n[_]:p[_],w=Mu(S,n[_],s[_],t[b],r[_],v);Du(w,i,s,_,_+h),m&&p.push(n[_]*(S-1)+l[_]+(t[b]-1)*r[_]+1-s[_]-s[_+h])}p.splice(0,0,g),p.splice(u?3:1,0,y)},Gi=(e,t)=>{let r=e.kernelShape.slice();if(e.kernelShape.length===0||e.kernelShape.reduce((m,g)=>m*g,1)===0){r.length=0;for(let m=2;m<t[1].dims.length;++m)r.push(t[1].dims[m])}let i=e.format==="NHWC";r.splice(0,0,t[1].dims[0]),r.splice(i?3:1,0,t[1].dims[1]);let a=e.pads.slice(),s=e.outputShape.slice(),n=e.outputPadding.slice(),u=t[0].dims,l=e.dilations.slice();if(l.reduce((m,g)=>m+g,0)===0){let m=t[0].dims.length-2;l=new Array(m).fill(1)}let p=e.strides.slice();if(p.reduce((m,g)=>m+g,0)===0){let m=t[0].dims.length-2;p=new Array(m).fill(1)}Uu(u,r,l,e.autoPad,e.group,a,p,i,n,s);let h=Object.assign({},e);return Object.assign(h,{kernelShape:r,pads:a,outputPadding:n,outputShape:s,dilations:l,strides:p}),h},Kc=e=>{var g;let t=Fa(e),r=e.format,i=["NOTSET","VALID","SAME_UPPER","SAME_LOWER"][typeof e.autoPad>"u"?0:e.autoPad],a=e.dilations,s=(g=e.group)!=null?g:1,n=e.kernelShape,u=e.pads,l=e.strides,p=e.wIsConst(),h=e.outputPadding,m=e.outputShape;return{autoPad:i,format:r,dilations:a,group:s,kernelShape:n,outputPadding:h,outputShape:m,pads:u,strides:l,wIsConst:p,...t,cacheKey:`${e.format};${t.activation};`}},Pu=(e,t)=>{if(!e||e.length!==2&&e.length!==3)throw new Error("Conv requires 2 or 3 inputs");if(e[0].dims.length!==4&&e[0].dims.length!==3)throw new Error("currently only support 2-dimensional conv");if(e[0].dims.length!==e[1].dims.length)throw new Error("filter does not have same dimension as input");let r=e[0].dims[t.format==="NHWC"?e[0].dims.length-1:1],i=e[1].dims[0];if(r!==i)throw new Error("FILTER_IN_CHANNEL should be equal to DATA_CHANNEL");let a=e[1].dims[1]*t.group;if(e.length===3&&(e[2].dims.length!==1||e[2].dims[0]!==a))throw new Error("invalid bias");let s=e[0].dims.length-2;if(t.dilations.reduce((n,u)=>n+u,0)>0&&t.dilations.length!==s)throw new Error(`dilations should be ${s}D`);if(t.strides.reduce((n,u)=>n+u,0)>0&&t.strides.length!==s)throw new Error(`strides should be ${s}D`);if(t.pads.reduce((n,u)=>n+u,0)>0&&t.pads.length!==s*2)throw new Error(`pads should be ${s*2}D`);if(t.outputPadding.length!==s&&t.outputPadding.length!==0)throw new Error(`output_padding should be ${s}D`);if(t.kernelShape.reduce((n,u)=>n+u,0)>0&&t.kernelShape.length!==0&&t.kernelShape.length!==e[1].dims.length-2)throw new Error("invalid kernel shape");if(t.outputShape.length!==0&&t.outputShape.length!==e[0].dims.length-2)throw new Error("invalid output shape")},Hi=(e,t,r,i)=>{var n;let a=(n=e.kernelCustomData.wT)!=null?n:e.compute(Pe(t[1],[2,3,0,1]),{inputs:[1],outputs:[r.wIsConst?-2:-1]})[0];r.wIsConst&&!e.kernelCustomData.wT&&(e.kernelCustomData.wT=a);let s=[t[0],a];t.length===3&&s.push(t[2]),e.compute(jc(s,r,i),{inputs:s})},qu=(e,t)=>{let r=t.format==="NHWC",i=[e.inputs[0].reshape(r?[e.inputs[0].dims[0],1,e.inputs[0].dims[1],e.inputs[0].dims[2]]:[e.inputs[0].dims[0],e.inputs[0].dims[1],1,e.inputs[0].dims[2]]),e.inputs[1].reshape([e.inputs[1].dims[0],e.inputs[1].dims[1],1,e.inputs[1].dims[2]])];e.inputs.length===3&&i.push(e.inputs[2]);let a=t.kernelShape;(a.length===0||a[0]===0)&&(a=[e.inputs[1].dims[2]]);let s=t.dilations;(s.length===0||s[0]===0)&&(s=[1]);let n=t.strides;(n.length===0||n[0]===0)&&(n=[1]);let u=t.pads;u.length===0&&(u=[0,0]),u=[0,u[0],0,u[1]],n=[1].concat(n),s=[1].concat(s),a=[1].concat(a);let l=t.outputPadding;l=[0].concat(l);let p=Gi({...t,pads:u,strides:n,dilations:s,kernelShape:a,outputPadding:l},i);Hi(e,i,p,h=>r?[h[0],h[2],h[3]]:[h[0],h[1],h[3]])},Zc=(e,t)=>{if(Pu(e.inputs,t),e.inputs[0].dims.length===3)qu(e,t);else{let r=Gi(t,e.inputs);Hi(e,e.inputs,r)}}}),Lu,Xc,Qc,f0=U(()=>{te(),ie(),xe(),ae(),Lu=(e,t,r,i)=>{let a=R.size(t),s=t.length,n=N("input",e,s),u=Q("output",e,s),l=r.dataType===6?r.getInt32Array()[0]:Number(r.getBigInt64Array()[0]),p=R.normalizeAxis(l,s),h=m=>{let g=` i32(${n.indicesGet("inputIndices","uniforms.axis")}) `,y=J("uniforms.input_shape","uniforms.axis",s),_=i.reverse?g+(i.exclusive?" + 1":""):"0",b=i.reverse?y:g+(i.exclusive?"":" + 1");return`
                ${m.registerUniform("outputSize","u32").registerUniform("axis","u32").declareVariables(n,u)}
                ${m.mainStart()}
                  ${m.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.outputSize")}
                  var inputIndices = ${u.offsetToIndices("global_idx")};
                  var sum = ${u.type.value}(0);
                  let first : i32 = ${_};
                  let last : i32 = ${b};
                  for (var i : i32 = first; i < last; i++) {
                    ${n.indicesSet("inputIndices","uniforms.axis","u32(i)")};
                    sum = sum + ${n.getByIndices("inputIndices")};
                  }
                  ${u.setByOffset("global_idx","sum")};
                }`};return{name:"CumSum",shaderCache:{hint:i.cacheKey,inputDependencies:["rank"]},getRunData:()=>({outputs:[{dims:t,dataType:e}],dispatchGroup:{x:Math.ceil(a/64)},programUniforms:[{type:12,data:a},{type:12,data:p},...ee(t,t)]}),getShaderSource:h}},Xc=(e,t)=>{let r=e.inputs[0].dims,i=e.inputs[0].dataType,a=e.inputs[1];e.compute(Lu(i,r,a,t),{inputs:[0]})},Qc=e=>{let t=e.exclusive===1,r=e.reverse===1;return fe({exclusive:t,reverse:r})}}),Wu,Vu,Gu,Yc,Jc,m0=U(()=>{te(),ie(),xe(),ae(),Wu=e=>{if(!e||e.length!==1)throw new Error("DepthToSpace requires 1 input.");if(e[0].dims.length!==4)throw new Error("DepthToSpace requires 4D input.")},Vu=(e,t,r,i)=>{let a=[];a.push(`fn perm(i: ${i.type.indices}) -> ${r.type.indices} {
    var a: ${r.type.indices};`);for(let s=0;s<t;++s)a.push(r.indicesSet("a",e[s],`i[${s}]`));return a.push("return a;}"),a.join(`
`)},Gu=(e,t)=>{let r,i,a,s,n,u,l=t.format==="NHWC",p=t.blocksize,h=t.mode==="DCR";l?([r,i,a,s]=e.dims,n=h?[r,i,a,p,p,s/p**2]:[r,i,a,s/p**2,p,p],u=h?[0,1,3,2,4,5]:[0,1,4,2,5,3]):([r,i,a,s]=[e.dims[0],e.dims[2],e.dims[3],e.dims[1]],n=h?[r,p,p,s/p**2,i,a]:[r,s/p**2,p,p,i,a],u=h?[0,3,4,1,5,2]:[0,1,4,2,5,3]);let m=e.reshape(n),g=m.dims.length,y=e.dataType,_=N("a",y,g),b=Q("output",y,g),S=v=>`
  ${v.registerUniform("output_size","u32").declareVariables(_,b)}

  ${Vu(u,g,_,b)}

  ${v.mainStart()}
    ${v.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.output_size")}

    let indices = ${b.offsetToIndices("global_idx")};
    let aIndices = perm(indices);

    ${b.setByOffset("global_idx",_.getByIndices("aIndices"))}
  }`;return{name:"DepthToSpace",shaderCache:{hint:`${e.dims};${t.blocksize};${t.mode}`,inputDependencies:["rank"]},getRunData:v=>{let w=l?[r,i*p,a*p,s/p**2]:[r,s/p**2,i*p,a*p],I=R.size(w),k=m.dims,E=R.sortBasedOnPerm(k,u);return{outputs:[{dims:w,dataType:v[0].dataType}],dispatchGroup:{x:Math.ceil(I/64)},programUniforms:[{type:12,data:I},...ee(k,E)]}},getShaderSource:S}},Yc=(e,t)=>{Wu(e.inputs),e.compute(Gu(e.inputs[0],t))},Jc=e=>fe({blocksize:e.blocksize,mode:e.mode,format:e.format})}),Nr,tr,Fi,Hu,Fu,ju,Ku,ji,Zu,eh,th,g0=U(()=>{te(),ie(),xe(),ae(),Nr="[a-zA-Z]|\\.\\.\\.",tr="("+Nr+")+",Fi="^"+tr+"$",Hu="("+tr+",)*"+tr,Fu="^"+Hu+"$",ju=class{constructor(e=-1){this.symbolToIndices=new Map,this.inputIndex=e}addSymbol(e,t){let r=this.symbolToIndices.get(e);r===void 0?r=[t]:r.push(t),this.symbolToIndices.set(e,r)}},Ku=class{constructor(e,t){var a;this.equation=t,this.hasEllipsis=!1,this.symbolToInfo=new Map,this.lhs=new Array,this.outputDims=[];let[r,i]=t.includes("->")?t.split("->",2):[t,""];if(!r.match(RegExp(Fu)))throw new Error("Invalid LHS term");if(r.split(",").forEach((s,n)=>{let u=e[n].dims.slice();if(!s.match(RegExp(Fi)))throw new Error("Invalid LHS term");let l=this.processTerm(s,!0,u,n);this.lhs.push(l)}),i==="")i+=[...this.symbolToInfo.entries()].filter(([s,n])=>n.count===1||s==="...").map(([s])=>s).join("");else if(!i.match(RegExp(tr)))throw new Error("Invalid RHS");(a=i.match(RegExp(Nr,"g")))==null||a.forEach(s=>{if(s==="...")this.outputDims=this.outputDims.concat(this.ellipsisDims);else{let n=this.symbolToInfo.get(s);if(n===void 0)throw new Error("Invalid RHS symbol");this.outputDims.push(n.dimValue)}}),this.rhs=this.processTerm(i,!1,this.outputDims)}addSymbol(e,t,r){let i=this.symbolToInfo.get(e);if(i!==void 0){if(i.dimValue!==t&&i.count!==1)throw new Error("Dimension mismatch");i.count++,i.inputIndices.push(r)}else i={count:1,dimValue:t,inputIndices:[r]};this.symbolToInfo.set(e,i)}processTerm(e,t,r,i=-1){let a=r.length,s=!1,n=[],u=0;if(!e.match(RegExp(Fi))&&!t&&e!=="")throw new Error("Invalid LHS term");let l=e.match(RegExp(Nr,"g")),p=new ju(i);return l==null||l.forEach((h,m)=>{if(h==="..."){if(s)throw new Error("Only one ellipsis is allowed per input term");s=!0;let g=a-l.length+1;if(g<0)throw new Error("Ellipsis out of bounds");if(n=r.slice(u,u+g),this.hasEllipsis){if(this.ellipsisDims.length!==n.length||this.ellipsisDims.toString()!==n.toString())throw new Error("Ellipsis dimensions mismatch")}else if(t)this.hasEllipsis=!0,this.ellipsisDims=n;else throw new Error("Ellipsis must be specified in the LHS");for(let y=0;y<n.length;y++){let _=String.fromCharCode(48+y);p.addSymbol(_,m+y),this.addSymbol(_,r[u++],i)}}else p.addSymbol(h,m+(this.hasEllipsis?this.ellipsisDims.length-1:0)),this.addSymbol(h,r[u++],i)}),p}},ji=e=>e+"_max",Zu=(e,t,r,i)=>{let a=e.map(p=>p.length).map((p,h)=>N(`input${h}`,t,p)),s=R.size(i),n=Q("output",t,i.length),u=[...r.symbolToInfo.keys()].filter(p=>!r.rhs.symbolToIndices.has(p)),l=p=>{let h=[],m="var prod = 1.0;",g="var sum = 0.0;",y="sum += prod;",_=[],b=[],S=[],v=[],w=r.symbolToInfo.size===r.rhs.symbolToIndices.size;r.symbolToInfo.forEach((k,E)=>{var A;if(r.rhs.symbolToIndices.has(E)){let C=(A=r.rhs.symbolToIndices.get(E))==null?void 0:A[0];C!==void 0&&r.lhs.forEach((x,D)=>{if(k.inputIndices.includes(D)){let M=x.symbolToIndices.get(E);if(M===void 0)throw new Error("Invalid symbol error");M.forEach(P=>{h.push(`${a[D].indicesSet(`input${D}Indices`,P,n.indicesGet("outputIndices",C))}`)})}})}else r.lhs.forEach((C,x)=>{if(k.inputIndices.includes(x)){let D=C.symbolToIndices.get(E);if(D===void 0)throw new Error("Invalid symbol error");D.forEach(M=>{_.push(`${a[x].indicesSet(`input${x}Indices`,M,`${E}`)}`)}),v.push(`prod *= ${a[x].getByIndices(`input${x}Indices`)};`)}}),b.push(`for(var ${E}: u32 = 0; ${E} < uniforms.${ji(E)}; ${E}++) {`),S.push("}")});let I=w?[...h,`let sum = ${a.map((k,E)=>k.getByIndices(`input${E}Indices`)).join(" * ")};`]:[...h,g,...b,..._,m,...v,y,...S];return`
            ${p.registerUniforms(u.map(k=>({name:`${ji(k)}`,type:"u32"}))).registerUniform("outputSize","u32").declareVariables(...a,n)}

            ${p.mainStart()}
            ${p.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.outputSize")}
            var outputIndices = ${n.offsetToIndices("global_idx")};
            ${a.map((k,E)=>`var input${E}Indices: ${a[E].type.indices};`).join(`
`)}
            ${I.join(`
`)};
            ${n.setByOffset("global_idx","sum")};
          }`};return{name:"Einsum",shaderCache:{hint:r.equation,inputDependencies:e.map(()=>"rank")},getRunData:()=>{let p=u.filter(m=>r.symbolToInfo.has(m)).map(m=>{var g;return{type:12,data:((g=r.symbolToInfo.get(m))==null?void 0:g.dimValue)||0}});p.push({type:12,data:s});let h=e.map((m,g)=>[...ee(m)]).reduce((m,g)=>m.concat(g),p);return h.push(...ee(i)),{outputs:[{dims:i,dataType:t}],dispatchGroup:{x:Math.ceil(s/64)},programUniforms:h}},getShaderSource:l}},eh=(e,t)=>{let r=new Ku(e.inputs,t.equation),i=r.outputDims,a=e.inputs.map((s,n)=>s.dims);e.compute(Zu(a,e.inputs[0].dataType,r,i))},th=e=>{let t=e.equation.replace(/\s+/g,"");return fe({equation:t})}}),Xu,Ki,Qu,Yu,rh,y0=U(()=>{te(),ie(),ae(),Xu=e=>{if(!e||e.length!==2)throw new Error("Expand requires 2 input.");let t=e[0].dims,r=Array.from(e[1].getBigInt64Array(),Number),i=r.length<t.length?0:r.length-t.length,a=t.length<r.length?0:t.length-r.length;for(;i<r.length&&a<t.length;++i,++a)if(r[i]!==t[a]&&r[i]!==1&&t[a]!==1)throw new Error("Expand requires shape to be broadcastable to input")},Ki=(e,t)=>{let r=e.length-t.length,i=[];for(let a=0;a<r;++a)i.push(e[a]);for(let a=0;a<t.length;++a)i.push(t[a]===1?e[a+r]:t[a]);return i},Qu=(e,t)=>e.length>t.length?Ki(e,t):Ki(t,e),Yu=e=>{let t=e[0].dims,r=Array.from(e[1].getBigInt64Array(),Number),i=Qu(t,r),a=e[0].dataType,s=a===9||R.size(t)===1,n=a===9||t.length>0&&t[t.length-1]%4===0?4:1,u=s||i.length>0&&i[i.length-1]%4===0?4:1,l=Math.ceil(R.size(i)/u),p=m=>{let g=N("input",a,t.length,n),y=Q("output",a,i.length,u),_;if(a===9){let b=(S,v,w="")=>`
          let outputIndices${v} = ${y.offsetToIndices(`outputOffset + ${v}u`)};
          let offset${v} = ${g.broadcastedIndicesToOffset(`outputIndices${v}`,y)};
          let index${v} = offset${v} / 4u;
          let component${v} = offset${v} % 4u;
          ${S}[${v}] = ${w}(${g.getByOffset(`index${v}`)}[component${v}]);
        `;_=`
        let outputOffset = global_idx * ${u};
        var data = vec4<u32>(0);
        ${b("data",0,"u32")}
        ${b("data",1,"u32")}
        ${b("data",2,"u32")}
        ${b("data",3,"u32")}
        ${y.setByOffset("global_idx","data")}
      }`}else _=`
        let outputIndices = ${y.offsetToIndices(`global_idx * ${u}`)};
        let inputOffset = ${g.broadcastedIndicesToOffset("outputIndices",y)};
        let data = ${y.type.value}(${g.getByOffset(`inputOffset / ${n}`)});
        ${y.setByOffset("global_idx","data")}
      }`;return`
    ${m.registerUniform("vec_size","u32").declareVariables(g,y)}
    ${m.mainStart()}
    ${m.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.vec_size")}
    ${_}`},h=[{type:12,data:l},...ee(t,i)];return{name:"Expand",shaderCache:{hint:`${i.length};${n}${u}`,inputDependencies:["rank"]},getShaderSource:p,getRunData:()=>({outputs:[{dims:i,dataType:e[0].dataType}],dispatchGroup:{x:Math.ceil(l/64)},programUniforms:h})}},rh=e=>{Xu(e.inputs),e.compute(Yu(e.inputs),{inputs:[0]})}}),Ju,ih,_0=U(()=>{te(),ie(),ae(),Ha(),Ju=e=>{let t=e[0].dataType,r=R.size(e[0].dims),i=R.size(e[1].dims),a=i%4===0,s=n=>{let u=N("x",t,[1],4),l=N("bias",t,[1],4),p=Q("y",t,[1],4),h=[{name:"output_vec_size",type:"u32"},{name:"bias_size",type:"u32"}],m=y=>`
      let bias${y}_offset: u32 = (global_idx * 4 + ${y}) % uniforms.bias_size;
      let bias${y} = ${l.getByOffset(`bias${y}_offset / 4`)}[bias${y}_offset % 4];`,g=a?`
      let bias = ${l.getByOffset("global_idx % (uniforms.bias_size / 4)")};`:`${m(0)}${m(1)}${m(2)}${m(3)}
      let bias = ${u.type.value}(bias0, bias1, bias2, bias3);`;return`${n.registerUniforms(h).declareVariables(u,l,p)}

    ${wa(ze(t))}

    ${n.mainStart(Vt)}
      ${n.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.output_vec_size")}

      let x = ${u.getByOffset("global_idx")};
      ${g}
      let x_in = x + bias;
      ${p.setByOffset("global_idx",va("x_in"))}
    }`};return{name:"FastGeluWithBias",shaderCache:{hint:`${a}`,inputDependencies:["type","type"]},getShaderSource:s,getRunData:n=>({outputs:[{dims:n[0].dims,dataType:n[0].dataType}],programUniforms:[{type:12,data:Math.ceil(r/4)},{type:12,data:i}],dispatchGroup:{x:Math.ceil(r/Vt/4)}})}},ih=e=>{e.inputs.length<2||R.size(e.inputs[1].dims)===0?xc(e):e.compute(Ju(e.inputs))}}),el,tl,ah,nh,b0=U(()=>{te(),ie(),xe(),ae(),el=e=>{if(!e||e.length!==2)throw new Error("Gather requires 2 inputs.")},tl=(e,t)=>{let r=e[0].dims,i=e[1].dims,a=r.length,s=R.normalizeAxis(t.axis,a),n=r.slice(0);n.splice(s,1,...i);let u=r[s],l=e[0].dataType===9?4:1,p=Math.ceil(R.size(n)/l),h=[{type:12,data:p},{type:6,data:u},{type:12,data:s},...ee(e[0].dims,e[1].dims,n)],m=g=>{let y=N("data",e[0].dataType,e[0].dims.length,l),_=N("inputIndices",e[1].dataType,e[1].dims.length),b=Q("output",e[0].dataType,n.length,l),S=w=>{let I=i.length,k=`var indicesIndices${w}  = ${_.type.indices}(0);`;for(let E=0;E<I;E++)k+=`${I>1?`indicesIndices${w}[${E}]`:`indicesIndices${w}`} = ${n.length>1?`outputIndices${w}[uniforms.axis + ${E}]`:`outputIndices${w}`};`;k+=`
          var idx${w} = ${_.getByIndices(`indicesIndices${w}`)};
          if (idx${w} < 0) {
            idx${w} = idx${w} + uniforms.axisDimLimit;
          }
          var dataIndices${w} : ${y.type.indices};
        `;for(let E=0,A=0;E<a;E++)E===s?(k+=`${a>1?`dataIndices${w}[${E}]`:`dataIndices${w}`} = u32(idx${w});`,A+=I):(k+=`${a>1?`dataIndices${w}[${E}]`:`dataIndices${w}`} = ${n.length>1?`outputIndices${w}[${A}]`:`outputIndices${w}`};`,A++);return k},v;if(e[0].dataType===9){let w=(I,k,E="")=>`
          let outputIndices${k} = ${b.offsetToIndices(`outputOffset + ${k}u`)};
          ${S(k)};
          let offset${k} = ${y.indicesToOffset(`dataIndices${k}`)};
          let index${k} = offset${k} / 4u;
          let component${k} = offset${k} % 4u;
          ${I}[${k}] = ${E}(${y.getByOffset(`index${k}`)}[component${k}]);
        `;v=`
        let outputOffset = global_idx * ${l};
        var value = vec4<u32>(0);
        ${w("value",0,"u32")}
        ${w("value",1,"u32")}
        ${w("value",2,"u32")}
        ${w("value",3,"u32")}
        ${b.setByOffset("global_idx","value")}
      `}else v=`
      let outputIndices = ${b.offsetToIndices("global_idx")};
      ${S("")};
      let value = ${y.getByIndices("dataIndices")};
      ${b.setByOffset("global_idx","value")};
      `;return`
      ${g.registerUniform("outputSize","u32").registerUniform("axisDimLimit","i32").registerUniform("axis","u32").declareVariables(y,_,b)}
      ${g.mainStart()}
        ${g.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.outputSize")}
        ${v}
      }`};return{name:"Gather",shaderCache:{hint:t.cacheKey,inputDependencies:["rank","rank"]},getRunData:()=>({outputs:[{dims:n,dataType:e[0].dataType}],dispatchGroup:{x:Math.ceil(p/64)},programUniforms:h}),getShaderSource:m}},ah=e=>fe({axis:e.axis}),nh=(e,t)=>{let r=e.inputs;el(r),e.compute(tl(e.inputs,t))}}),rl,sh,oh,$0=U(()=>{te(),ie(),ae(),rl=(e,t,r,i,a,s,n,u,l)=>{let p=[{type:12,data:s},{type:12,data:i},{type:12,data:a},{type:12,data:r},{type:12,data:n},{type:12,data:u},{type:12,data:l}],h=[s];p.push(...ee(t.dims,h));let m=g=>{let y=N("indices_data",t.dataType,t.dims.length),_=Q("input_slice_offsets_data",12,1,1),b=[y,_],S=[{name:"output_size",type:"u32"},{name:"batch_dims",type:"u32"},{name:"input_dims",type:"u32",length:a.length},{name:"sizes_from_slice_dims_data",type:"u32",length:r.length},{name:"num_slices_per_batch",type:"u32"},{name:"input_batch_stride",type:"u32"},{name:"num_slice_dims",type:"u32"}];return`
  ${g.registerUniforms(S).declareVariables(...b)}
  ${g.mainStart()}
    ${g.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.output_size")}
    let batch_idx = global_idx / uniforms.num_slices_per_batch;
    let base_offset = batch_idx * uniforms.input_batch_stride;

    let slice_indices_base_offset = global_idx * uniforms.num_slice_dims;
    var relative_slice_offset = 0;
    for (var dim_idx = 0u; dim_idx < uniforms.num_slice_dims; dim_idx ++) {
      var index = i32(indices_data[dim_idx + slice_indices_base_offset].x);
      let input_dim_idx = uniforms.batch_dims + dim_idx;
      if (index < 0) {
        ${a.length===1?"index += i32(uniforms.input_dims);":"index += i32(uniforms.input_dims[input_dim_idx]);"}
      }
      ${r.length===1?"relative_slice_offset += index * i32(uniforms.sizes_from_slice_dims_data);":"relative_slice_offset += index * i32(uniforms.sizes_from_slice_dims_data[dim_idx]);"}
    }

    input_slice_offsets_data[global_idx] =  base_offset + u32(relative_slice_offset);
  }`};return e.compute({name:"computeSliceOffsets",shaderCache:{hint:`${a.length}_${r.length}`,inputDependencies:["rank"]},getRunData:()=>({outputs:[{dims:h,dataType:e.inputs[1].dataType}],dispatchGroup:{x:Math.ceil(s/64)},programUniforms:p}),getShaderSource:m},{inputs:[t],outputs:[-1]})[0]},sh=(e,t)=>{let r=e.inputs,i=r[0].dims,a=r[0].dataType,s=r[1].dims,n=s[s.length-1],u=R.sizeToDimension(s,s.length-1),l=R.sizeFromDimension(i,t.batchDims+n),p=R.sizeToDimension(i,t.batchDims),h=R.sizeFromDimension(i,t.batchDims),m=u/p,g=new Array(n),y=l;for(let k=0;k<n;++k)g[n-1-k]=y,y*=i[t.batchDims+n-1-k];let _=rl(e,r[1],g,t.batchDims,i,u,m,h,n),b=t.batchDims+n;if(b>i.length)throw new Error("last dimension of indices must not be larger than rank of input tensor");let S=s.slice(0,-1).concat(i.slice(b)),v=R.size(S),w=[{type:12,data:v},{type:12,data:l},...ee(r[0].dims,_.dims,S)],I=k=>{let E=N("data",r[0].dataType,r[0].dims.length),A=N("slice_offsets",12,_.dims.length),C=Q("output",r[0].dataType,S.length);return`
          ${k.registerUniform("output_size","u32").registerUniform("slice_size","u32").declareVariables(E,A,C)}
            ${k.mainStart()}
            ${k.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.output_size")}
          let slice_offset = slice_offsets[global_idx / uniforms.slice_size];
          output[global_idx] = data[u32(slice_offset) + global_idx % uniforms.slice_size];
        }`};e.compute({name:"GatherND",shaderCache:{hint:t.cacheKey,inputDependencies:["rank","rank"]},getRunData:()=>({outputs:[{dims:S,dataType:a}],dispatchGroup:{x:Math.ceil(v/64)},programUniforms:w}),getShaderSource:I},{inputs:[r[0],_]})},oh=e=>({batchDims:e.batch_dims,cacheKey:""})}),il,al,uh,lh,w0=U(()=>{te(),ie(),xe(),ae(),il=(e,t)=>{if(e.length<3||e.length>4)throw new Error("GatherBlockQuantized requires 3 or 4 inputs.");let r=R.normalizeAxis(t.quantizeAxis,e[0].dims.length),i=t.blockSize,a=e[0],s=e[2],n=e.length===4?e[3]:void 0;if(s.dims.length!==a.dims.length||!a.dims.map((u,l)=>l===r?Math.ceil(u/i)===s.dims[l]:u===s.dims[l]).reduce((u,l)=>u&&l,!0))throw new Error("Scales must have the same rank as the input tensor and the dims should match except on gatherAxis.");if(n){if(n.dataType!==a.dataType)throw new Error("Zero point must have the same data type as the input tensor.");if(n.dims.length!==s.dims.length||!n.dims.map((u,l)=>u===s.dims[l]).reduce((u,l)=>u&&l,!0))throw new Error("Zero point must have the same rank as the input tensor and the dims should match except on quantizeAxis.")}},al=(e,t)=>{let r=e[0].dims,i=e[1].dims,a=r.length,s=R.normalizeAxis(t.gatherAxis,a),n=R.normalizeAxis(t.quantizeAxis,a),u=r.slice(0);u.splice(s,1,...i);let l=R.size(u),p=e[2].dataType,h=e[0].dataType===22,m=[{type:12,data:l},{type:12,data:n},{type:12,data:s},{type:12,data:t.blockSize},...ee(...e.map((y,_)=>y.dims),u)],g=y=>{let _=N("data",e[0].dataType,e[0].dims.length),b=N("inputIndices",e[1].dataType,e[1].dims.length),S=N("scales",e[2].dataType,e[2].dims.length),v=e.length>3?N("zeroPoint",e[3].dataType,e[3].dims.length):void 0,w=Q("output",p,u.length),I=[_,b,S];v&&I.push(v);let k=[{name:"output_size",type:"u32"},{name:"quantize_axis",type:"u32"},{name:"gather_axis",type:"u32"},{name:"block_size",type:"u32"}];return`
        ${y.registerUniforms(k).declareVariables(...I,w)}
        ${y.mainStart()}
        let output_indices = ${w.offsetToIndices("global_idx")};
        var indices_indices = ${b.type.indices}(0);
        ${i.length>1?`
          for (var i: u32 = 0; i < ${i.length}; i++) {
            let index = ${w.indicesGet("output_indices","uniforms.gather_axis + i")};
            ${b.indicesSet("indices_indices","i","index")};
          }`:`indices_indices = ${w.indicesGet("output_indices","uniforms.gather_axis")};`};
        var data_indices = ${_.type.indices}(0);
        for (var i: u32 = 0; i < uniforms.gather_axis; i++) {
          let index = ${w.indicesGet("output_indices","i")};
          ${_.indicesSet("data_indices","i","index")};
        }
        var index_from_indices = ${b.getByIndices("indices_indices")};
        if (index_from_indices < 0) {
          index_from_indices += ${r[s]};
        }
        ${_.indicesSet("data_indices","uniforms.gather_axis","u32(index_from_indices)")};
        for (var i = uniforms.gather_axis + 1; i < ${u.length}; i++) {
          let index = ${w.indicesGet("output_indices",`i + ${i.length} - 1`)};
          ${_.indicesSet("data_indices","i","index")};
        }
        let data_offset = ${_.indicesToOffset("data_indices")};
        let data_index = data_offset % 8;
        // Convert 4-bit packed data to 8-bit packed data.
        let packed_4bit_quantized_data = ${_.getByOffset("data_offset / 8")};
        let packed_8bit_quantized_data = (packed_4bit_quantized_data >> (4 * (data_index % 2))) & 0x0f0f0f0f;
        let quantized_data_vec = ${h?"unpack4xI8":"unpack4xU8"}(u32(packed_8bit_quantized_data));
        let quantized_data = quantized_data_vec[data_index / 2];
        var scale_indices = data_indices;
        let quantize_axis_index = ${S.indicesGet("data_indices","uniforms.quantize_axis")} / uniforms.block_size;
        ${S.indicesSet("scale_indices","uniforms.quantize_axis","quantize_axis_index")};
        var scale = ${S.getByIndices("scale_indices")};
        ${v?`
              let zero_point_indices = scale_indices;
              let zero_point_offset = ${v.indicesToOffset("zero_point_indices")};
              let zero_point_index = zero_point_offset % 8;
              let packed_4bit_zero_points = ${v.getByOffset("zero_point_offset / 8")};
              let packed_8bit_zero_points = (packed_4bit_zero_points >> (4 * (zero_point_index % 2))) & 0x0f0f0f0f;
              let zero_point_vec = ${h?"unpack4xI8":"unpack4xU8"}(u32(packed_8bit_zero_points));
              let zero_point = zero_point_vec[zero_point_index / 2];`:"var zero_point = 0"};
        let dequantized_data = ${ze(p)}(quantized_data - zero_point) * scale;
        ${w.setByOffset("global_idx","dequantized_data")};
    }`};return{name:"GatherBlockQuantized",shaderCache:{hint:`${t.cacheKey};${e.filter((y,_)=>_!==1).map(y=>y.dims.join("_")).join(";")}`,inputDependencies:Array.from({length:e.length},(y,_)=>"rank")},getRunData:()=>({outputs:[{dims:u,dataType:p}],dispatchGroup:{x:Math.ceil(l/64)},programUniforms:m}),getShaderSource:g}},uh=(e,t)=>{let r=e.inputs;il(r,t),e.compute(al(e.inputs,t))},lh=e=>fe({blockSize:e.blockSize,gatherAxis:e.gatherAxis,quantizeAxis:e.quantizeAxis})}),nl,sl,dh,ph,v0=U(()=>{te(),ie(),xe(),ae(),nl=e=>{if(!e||e.length!==2)throw new Error("GatherElements requires 2 inputs.");if(e[0].dims.length<1)throw new Error("GatherElements requires that the data input be rank >= 1.");if(e[0].dims.length!==e[1].dims.length)throw new Error(`GatherElements requires that the data input and
                     indices input tensors be of same rank.`)},sl=(e,t)=>{let r=e[0].dims,i=e[0].dataType,a=r.length,s=e[1].dims,n=e[1].dataType,u=R.normalizeAxis(t.axis,a),l=r[u],p=s.slice(0),h=R.size(p),m=N("input",i,a),g=N("indicesInput",n,s.length),y=Q("output",i,p.length),_=[{type:12,data:h},{type:6,data:l},{type:12,data:u}];return _.push(...ee(r,s,p)),{name:"GatherElements",shaderCache:{inputDependencies:["rank","rank"]},getRunData:()=>({outputs:[{dims:p,dataType:e[0].dataType}],dispatchGroup:{x:Math.ceil(h/64)},programUniforms:_}),getShaderSource:b=>`
      ${b.registerUniform("outputSize","u32").registerUniform("axisDimLimit","i32").registerUniform("axis","u32").declareVariables(m,g,y)}
      ${b.mainStart()}
      ${b.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.outputSize")}

      let outputIndices = ${y.offsetToIndices("global_idx")};

      var idx = ${g.getByOffset("global_idx")};
      if (idx < 0) {
        idx = idx + uniforms.axisDimLimit;
      }
      var inputIndices = ${m.type.indices}(outputIndices);
      ${m.indicesSet("inputIndices","uniforms.axis","u32(idx)")};
      let value = ${m.getByIndices("inputIndices")};

      ${y.setByOffset("global_idx","value")};
  }`}},dh=e=>fe({axis:e.axis}),ph=(e,t)=>{let r=e.inputs;nl(r),e.compute(sl(e.inputs,t))}}),ol,ul,ch,hh,x0=U(()=>{te(),ie(),ae(),ol=e=>{if(!e)throw new Error("Input is missing");if(e.length<2||e.length>3)throw new Error("Invaid input number.");if(e.length===3&&e[2].dims.length>2)throw new Error("Invalid input shape of C");if(e[0].dataType!==e[1].dataType||e.length===3&&e[0].dataType!==e[2].dataType)throw new Error("Input types are mismatched")},ul=(e,t)=>{let r=e[0].dims.slice(),i=e[1].dims.slice(),[a,s,n]=dp.getShapeOfGemmResult(r,t.transA,i,t.transB,e.length===3?e[2].dims:void 0),u=[a,s];if(!u)throw new Error("Can't use gemm on the given tensors");let l=16,p=Math.ceil(s/l),h=Math.ceil(a/l),m=!0,g=R.size(u),y=[{type:12,data:m?p:g},{type:12,data:a},{type:12,data:s},{type:12,data:n},{type:1,data:t.alpha},{type:1,data:t.beta}],_=["type","type"];e.length===3&&(y.push(...ee(e[2].dims)),_.push("rank")),y.push(...ee(u));let b=v=>{let w="";t.transA&&t.transB?w="value += a[k * uniforms.M + m] * b[n * uniforms.K + k];":t.transA&&!t.transB?w="value += a[k * uniforms.M + m] * b[k * uniforms.N + n];":!t.transA&&t.transB?w="value += a[m * uniforms.K + k] * b[n * uniforms.K + k];":!t.transA&&!t.transB&&(w="value += a[m * uniforms.K + k] * b[k * uniforms.N + n];");let I=t.alpha===1?"":"value *= uniforms.alpha;",k=N("a",e[0].dataType,e[0].dims),E=N("b",e[1].dataType,e[1].dims),A=k.type.value,C=null,x=[k,E];e.length===3&&(C=N("c",e[2].dataType,e[2].dims.length),x.push(C));let D=Q("output",e[0].dataType,u.length);x.push(D);let M=[{name:"output_size",type:"u32"},{name:"M",type:"u32"},{name:"N",type:"u32"},{name:"K",type:"u32"},{name:"alpha",type:"f32"},{name:"beta",type:"f32"}];return`
  ${v.registerUniforms(M).declareVariables(...x)}

  ${v.mainStart()}
    ${v.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.output_size")}

    let m = global_idx / uniforms.N;
    let n = global_idx % uniforms.N;

    var value = ${A}(0);
    for (var k: u32 = 0u; k < uniforms.K; k++) {
      ${w}
    }

    ${I}
    ${C!=null?`let cOffset = ${C.broadcastedIndicesToOffset("vec2(m, n)",D)}; value += ${A}(uniforms.beta) * ${C.getByOffset("cOffset")};`:""}
    output[global_idx] = value;
  }`},S=v=>{let w=N("a",e[0].dataType,e[0].dims),I=N("b",e[1].dataType,e[1].dims),k=null,E=[w,I];e.length===3&&(k=N("c",e[2].dataType,e[2].dims.length),E.push(k));let A=Q("output",e[0].dataType,u.length);E.push(A);let C=[{name:"num_tile_n",type:"u32"},{name:"M",type:"u32"},{name:"N",type:"u32"},{name:"K",type:"u32"},{name:"alpha",type:"f32"},{name:"beta",type:"f32"}],x="",D="";t.transA&&t.transB?(D=`
      var col = tile_row_start + local_id.x;
      var row = k_start + local_id.y;
      if (col < uniforms.M && row < uniforms.K) {
        tile_a[local_id.y][local_id.x] = a[row * uniforms.M + col];
      } else {
        tile_a[local_id.y][local_id.x] = ${w.type.value}(0);
      }

      col = k_start + local_id.x;
      row = tile_col_start + local_id.y;
      if (col < uniforms.K && row < uniforms.N) {
        tile_b[local_id.y][local_id.x] = b[row * uniforms.K + col];
      } else {
        tile_b[local_id.y][local_id.x] = ${I.type.value}(0);
      }
      `,x="value += tile_a[k][local_id.y] * tile_b[local_id.x][k];"):t.transA&&!t.transB?(D=`
      var col = tile_row_start + local_id.x;
      var row = k_start + local_id.y;
      if (col < uniforms.M && row < uniforms.K) {
        tile_a[local_id.y][local_id.x] = a[row * uniforms.M + col];
      } else {
        tile_a[local_id.y][local_id.x] = ${w.type.value}(0);
      }

      col = tile_col_start + local_id.x;
      row = k_start + local_id.y;
      if (col < uniforms.N && row < uniforms.K) {
        tile_b[local_id.y][local_id.x] = b[row * uniforms.N + col];
      } else {
        tile_b[local_id.y][local_id.x] = ${I.type.value}(0);
      }
      `,x="value += tile_a[k][local_id.y] * tile_b[k][local_id.x];"):!t.transA&&t.transB?(D=`
      var col = k_start + local_id.x;
      var row = tile_row_start + local_id.y;
      if (col < uniforms.K && row < uniforms.M) {
        tile_a[local_id.y][local_id.x] = a[row * uniforms.K + col];
      } else {
        tile_a[local_id.y][local_id.x] = ${w.type.value}(0);
      }

      col = k_start + local_id.x;
      row = tile_col_start + local_id.y;
      if (col < uniforms.K && row < uniforms.N) {
        tile_b[local_id.y][local_id.x] = b[row * uniforms.K + col];
      } else {
        tile_b[local_id.y][local_id.x] = ${I.type.value}(0);
      }
      `,x="value += tile_a[local_id.y][k] * tile_b[local_id.x][k];"):!t.transA&&!t.transB&&(D=`
      var col = k_start + local_id.x;
      var row = tile_row_start + local_id.y;
      if (col < uniforms.K && row < uniforms.M) {
        tile_a[local_id.y][local_id.x] = a[row * uniforms.K + col];
      } else {
        tile_a[local_id.y][local_id.x] = ${w.type.value}(0);
      }

      col = tile_col_start + local_id.x;
      row = k_start + local_id.y;
      if (col < uniforms.N && row < uniforms.K) {
        tile_b[local_id.y][local_id.x] = b[row * uniforms.N + col];
      } else {
        tile_b[local_id.y][local_id.x] = ${I.type.value}(0);
      }
      `,x="value += tile_a[local_id.y][k] * tile_b[k][local_id.x];");let M=t.alpha===1?"":"value *= uniforms.alpha;";return`
  ${v.registerUniforms(C).declareVariables(...E)}
  var<workgroup> tile_a: array<array<${w.type.storage}, ${l}>, ${l}>;
  var<workgroup> tile_b: array<array<${I.type.storage}, ${l}>, ${l}>;
  ${v.mainStart([l,l,1])}
    let tile_col_start = (workgroup_index % uniforms.num_tile_n) * ${l};
    let tile_row_start = (workgroup_index / uniforms.num_tile_n) * ${l};
    let num_tiles = (uniforms.K - 1) / ${l} + 1;
    var k_start = 0u;
    var value = ${A.type.value}(0);
    for (var t: u32 = 0u; t < num_tiles; t++) {
      ${D}
      k_start = k_start + ${l};
      workgroupBarrier();

      for (var k: u32 = 0u; k < ${l}; k++) {
        ${x}
      }
      workgroupBarrier();
    }

    ${M}
    let m = tile_row_start + local_id.y;
    let n = tile_col_start + local_id.x;
    ${k!=null?`let cOffset = ${k.broadcastedIndicesToOffset("vec2(m, n)",A)}; value += ${A.type.value}(uniforms.beta) * ${k.getByOffset("cOffset")};`:""}
    if (m < uniforms.M && n < uniforms.N) {
      output[m * uniforms.N + n] = value;
    }
  }`};return m?{name:"GemmShared",shaderCache:{hint:`${t.cacheKey}`,inputDependencies:_},getRunData:()=>({outputs:[{dims:u,dataType:e[0].dataType}],dispatchGroup:{x:p*h},programUniforms:y}),getShaderSource:S}:{name:"Gemm",shaderCache:{hint:`${t.cacheKey}`,inputDependencies:_},getRunData:()=>({outputs:[{dims:u,dataType:e[0].dataType}],dispatchGroup:{x:Math.ceil(g/64)},programUniforms:y}),getShaderSource:b}},ch=e=>{let t=e.transA,r=e.transB,i=e.alpha,a=e.beta;return{transA:t,transB:r,alpha:i,beta:a,cacheKey:`${e.transA};${e.transB};${e.alpha===1}`}},hh=(e,t)=>{ol(e.inputs),e.compute(ul(e.inputs,t))}}),et,nt,xt,St,ll,dl,pl,cl,hl,fl,ml,gl,fh,mh,S0=U(()=>{te(),ie(),xe(),ae(),[et,nt,xt,St]=[0,1,2,3],ll=e=>{if(e[0].dims.length!==4)throw new Error("only 4-D tensor is supported.");if(e[0].dims.length!==e[1].dims.length)throw new Error("input dimensions must be equal to grid dimensions");if(e[0].dims.length-2!==e[1].dims[e[1].dims.length-1])throw new Error(`last dimension of grid must be equal to ${e[0].dims.length-2}`);if(e[0].dims[0]!==e[1].dims[0])throw new Error("grid batch size must match input batch size")},dl=`
  fn gs_get_cubic_coeffs(x: f32) -> vec4<f32> {
    let cubic_alpha = -0.75f;
    let x_abs = abs(x);
    var coeffs: vec4<f32>;
    coeffs[0] = (((cubic_alpha * (x_abs + 1) - 5 * cubic_alpha) * (x_abs + 1) + 8 * cubic_alpha) * (x_abs + 1) - 4 * cubic_alpha);
    coeffs[1] = (((cubic_alpha + 2) * x_abs - (cubic_alpha + 3)) * x_abs * x_abs + 1);
    coeffs[2] = (((cubic_alpha + 2) * (1 - x_abs) - (cubic_alpha + 3)) * (1 - x_abs) * (1 - x_abs) + 1);
    coeffs[3] = (((cubic_alpha * (2 - x_abs) - 5 * cubic_alpha) * (2 - x_abs) + 8 * cubic_alpha) * (2 - x_abs) - 4 * cubic_alpha);
    return coeffs;
  }
`,pl=e=>`
  fn gs_bicubic_interpolate(p: mat4x4<${e}>, x: f32, y: f32) -> ${e} {
    var v: vec4<f32>;
    var coeffs = gs_get_cubic_coeffs(x);
    for (var i = 0; i < 4; i++) {
      v[i] = coeffs[0] * p[i][0] + coeffs[1] * p[i][1] + coeffs[2] * p[i][2] + coeffs[3] * p[i][3];
    }
    coeffs = gs_get_cubic_coeffs(y);
    let pixel = ${e}(coeffs[0] * v[0] + coeffs[1] * v[1] + coeffs[2] * v[2] + coeffs[3] * v[3]);
    return pixel;
  }
`,cl=e=>`
  fn gs_denormalize(n: f32, length: i32) -> f32 {
    ${e.alignCorners===0?`
    // alignCorners: false => [-1, 1] to [-0.5, length - 0.5]
    return ((n + 1.0) * f32(length) - 1.0) / 2.0;
    `:`
    // alignCorners: true => [-1, 1] to [0, length - 1]
    return (n + 1.0) / 2.0 * (f32(length - 1));
    `}
  }
`,hl=e=>`
  ${e.paddingMode==="reflection"?`
      fn gs_reflect(x: i32, x_min: f32, x_max: f32) -> u32 {
        var dx = 0.0;
        var fx = f32(x);
        let range = x_max - x_min;
        if (fx < x_min) {
          dx = x_min - fx;
          let n = u32(dx / range);
          let r = dx - f32(n) * range;
          if (n % 2 == 0) {
            fx = x_min + r;
          } else {
            fx = x_max - r;
          }
        } else if (fx > x_max) {
          dx = fx - x_max;
          let n = u32(dx / range);
          let r = dx - f32(n) * range;
          if (n % 2 == 0) {
            fx = x_max - r;
          } else {
            fx = x_min + r;
          }
        }
        return u32(fx);
      }`:""}
`,fl=(e,t,r)=>`
  fn pixel_at_grid(r: i32, c: i32, H: i32, W: i32, batch: u32, channel: u32, border: vec4<f32>) -> ${t} {
     var pixel = ${t}(0);
     var indices = vec4<u32>(0);
     indices[${et}] = batch;
     indices[${nt}] = channel;`+(()=>{switch(r.paddingMode){case"zeros":return`
          if (r >= 0 && r < H && c >=0 && c < W) {
            indices[${xt}] = u32(r);
            indices[${St}] = u32(c);
          } else {
            return ${t}(0);
          }
        `;case"border":return`
          indices[${xt}] = u32(clamp(r, 0, H - 1));
          indices[${St}] = u32(clamp(c, 0, W - 1));
        `;case"reflection":return`
          indices[${xt}] = gs_reflect(r, border[1], border[3]);
          indices[${St}] = gs_reflect(c, border[0], border[2]);
        `;default:throw new Error(`padding mode ${r.paddingMode} is not supported`)}})()+`
    return ${e.getByIndices("indices")};
  }
`,ml=(e,t,r)=>(()=>{switch(r.mode){case"nearest":return`
          let result = pixel_at_grid(i32(round(y)), i32(round(x)), H_in, W_in, indices[${et}], indices[${nt}], border);
        `;case"bilinear":return`
          let x1 = i32(floor(x));
          let y1 = i32(floor(y));
          let x2 = x1 + 1;
          let y2 = y1 + 1;

          let p11 = pixel_at_grid(y1, x1, H_in, W_in, indices[${et}], indices[${nt}], border);
          let p12 = pixel_at_grid(y1, x2, H_in, W_in, indices[${et}], indices[${nt}], border);
          let p21 = pixel_at_grid(y2, x1, H_in, W_in, indices[${et}], indices[${nt}], border);
          let p22 = pixel_at_grid(y2, x2, H_in, W_in, indices[${et}], indices[${nt}], border);

          let dx2 = ${t}(f32(x2) - x);
          let dx1 = ${t}(x - f32(x1));
          let dy2 = ${t}(f32(y2) - y);
          let dy1 = ${t}(y - f32(y1));
          let result = dy2 * (dx2 * p11 + dx1 * p12) + dy1 * (dx2 * p21 + dx1 * p22);
        `;case"bicubic":return`
          let x0 = i32(floor(x)) - 1;
          let y0 = i32(floor(y)) - 1;
          var p: mat4x4<${t}>;
          for (var h = 0; h < 4; h++) {
            for (var w = 0; w < 4; w++) {
              p[h][w] = pixel_at_grid(h + y0, w + x0, H_in, W_in, indices[${et}], indices[${nt}], border);
            }
          }

          let dx = x - f32(x0 + 1);
          let dy = y - f32(y0 + 1);
          let result = gs_bicubic_interpolate(p, dx, dy);
        `;default:throw new Error(`mode ${r.mode} is not supported`)}})()+`${e.setByOffset("global_idx","result")}`,gl=(e,t)=>{let r=N("x",e[0].dataType,e[0].dims.length),i=[e[1].dims[0],e[1].dims[1],e[1].dims[2]],a=N("grid",e[1].dataType,i.length,2),s=[e[0].dims[0],e[0].dims[1],e[1].dims[1],e[1].dims[2]];t.format==="NHWC"&&(s=[e[0].dims[0],e[1].dims[1],e[1].dims[2],e[0].dims[3]],[et,nt,xt,St]=[0,3,1,2]);let n=Q("output",e[0].dataType,s.length),u=r.type.value,l=R.size(s),p=[{type:12,data:l},...ee(e[0].dims,i,s)],h=m=>`
  ${m.registerUniform("output_size","u32").declareVariables(r,a,n)}
  ${dl}
  ${pl(u)}
  ${cl(t)}
  ${hl(t)}
  ${fl(r,u,t)}

  ${m.mainStart()}
    ${m.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.output_size")}
      let H_in = i32(uniforms.x_shape[${xt}]);
      let W_in = i32(uniforms.x_shape[${St}]);

      ${t.alignCorners===0?`
      let x_min = -0.5;
      let x_max = f32(W_in) - 0.5;
      let y_min = -0.5;
      let y_max = f32(H_in) - 0.5;
      `:`
      let x_min = 0.0;
      let x_max = f32(W_in) - 1.0;
      let y_min = 0.0;
      let y_max = f32(H_in) - 1.0;
      `};
      let border = vec4<f32>(x_min, y_min, x_max, y_max);

      let indices = ${n.offsetToIndices("global_idx")};
      var grid_indices = vec3<u32>(indices[${et}], indices[${xt}], indices[${St}]);
      let nxy = ${a.getByIndices("grid_indices")};
      var x = gs_denormalize(f32(nxy[0]), W_in);
      var y = gs_denormalize(f32(nxy[1]), H_in);

      ${ml(n,u,t)}
  }`;return{name:"GridSample",shaderCache:{hint:`${t.cacheKey}`,inputDependencies:["type","type"]},getRunData:m=>{let g=R.size(s);return{outputs:[{dims:s,dataType:m[0].dataType}],dispatchGroup:{x:Math.ceil(g/64)},programUniforms:p}},getShaderSource:h}},fh=(e,t)=>{ll(e.inputs),e.compute(gl(e.inputs,t))},mh=e=>fe({alignCorners:e.align_corners,mode:e.mode,paddingMode:e.padding_mode,format:e.format})}),Ce,yl,gh,Zi,_l,lr,yh,_h=U(()=>{te(),ie(),xe(),La(),Ga(),ae(),_t(),Ce=(e,t)=>e.length>t&&e[t].dims.length>0?e[t]:void 0,yl=(e,t)=>{let r=e[0],i=Ce(e,1),a=Ce(e,2),s=Ce(e,3),n=Ce(e,4),u=Ce(e,5),l=Ce(e,6),p=Ce(e,7);if(r.dims.length!==3&&r.dims.length!==5)throw new Error("Input query is expected to have 3 or 5 dimensions");let h=r.dims[0],m=r.dims[1],g=r.dims.length===3?r.dims[2]:t.numHeads*r.dims[4],y=m,_=0,b=0,S=Math.floor(g/t.numHeads);if(l&&p&&R.size(l.dims)&&R.size(p.dims)){if(l.dims.length!==4)throw new Error('Input "past_key" is expected to have 4 dimensions');if(l.dims[0]!==h||l.dims[1]!==t.numHeads||l.dims[3]!==S)throw new Error('Input "past_key" shape (batch_size, num_heads, past_sequence_length, head_size)');if(p.dims[0]!==h||p.dims[1]!==t.numHeads||p.dims[3]!==S)throw new Error('Input "past_value" shape (batch_size, num_heads, past_sequence_length, head_size)');if(l.dims[2]!==p.dims[2])throw new Error('Input "past_key" and "past_value" shall have same dim 2 (past_sequence_length)');if(p.dims.length!==4)throw new Error('Input "past_value" is expected to have 4 dimensions');_=l.dims[2],b=l.dims[2]}else if(l&&R.size(l.dims)||p&&R.size(p.dims))throw new Error('Input "past_key" and "past_value" shall be both present or both absent');let v;if(i&&R.size(i.dims)>0){if(r.dims.length!==3)throw new Error('Input "query" is expected to have 3 dimensions when key is given');if(i.dims.length<3||i.dims.length>5)throw new Error('Input "key" is expected to have 3, 4, or 5 dimensions');if(r.dims[0]!==i.dims[0])throw new Error('Input "query" and "key" shall have same dim 0 (batch size)');if(i.dims.length===3){if(i.dims[2]!==r.dims[2])throw new Error('Input "query" and "key" shall have same dim 2 (hidden_size)');v=2,y=i.dims[1]}else if(i.dims.length===5){if(i.dims[2]!==t.numHeads||i.dims[3]!==2||i.dims[4]!==S)throw new Error('Expect "key" shape (batch_size, kv_sequence_length, num_heads, 2, head_size) for packed kv');if(a)throw new Error('Expect "value" be none when "key" has packed kv format.');v=5,y=i.dims[1]}else{if(i.dims[1]!==t.numHeads||i.dims[3]!==S)throw new Error('Expect "key" shape (batch_size, num_heads, kv_sequence_length, head_size) for past_key');v=0,y=i.dims[2]}}else{if(r.dims.length!==5)throw new Error('Input "query" is expected to have 5 dimensions when key is empty');if(r.dims[2]!==t.numHeads||r.dims[3]!==3)throw new Error('Expect "query" shape (batch_size, kv_sequence_length, num_heads, 3, head_size) for packed kv');v=3}if(s&&R.size(s.dims)>0){if(s.dims.length!==1)throw new Error('Input "bias" is expected to have 1 dimension');if(i&&i.dims.length===5&&i.dims[3]===2)throw new Error("bias is not allowed for packed kv.")}let w=_+y,I=0;if(n&&R.size(n.dims)>0){I=8;let C=n.dims;throw C.length===1?C[0]===h?I=1:C[0]===3*h+2&&(I=3):C.length===2&&C[0]===h&&C[1]===w&&(I=5),I===8?new Error('Input "key_padding_mask" shape shall be (batch_size) or (batch_size, total_sequence_length)'):new Error("Mask not supported")}let k=!1,E=g;if(a&&R.size(a.dims)>0){if(a.dims.length!==3&&a.dims.length!==4)throw new Error('Input "value" is expected to have 3 or 4 dimensions');if(r.dims[0]!==a.dims[0])throw new Error('Input "query" and "value" shall have same dim 0 (batch_size)');if(a.dims.length===3){if(y!==a.dims[1])throw new Error('Input "key" and "value" shall have the same dim 1 (kv_sequence_length)');E=a.dims[2]}else{if(y!==a.dims[2])throw new Error('Input "key" and "value" shall have the same dim 2 (kv_sequence_length)');E=a.dims[1]*a.dims[3],k=!0}}let A=!1;if(n&&R.size(n.dims)>0)throw new Error("Key padding mask is not supported");if(u&&R.size(u.dims)>0){if(u.dims.length!==4)throw new Error('Input "attention_bias" is expected to have 4 dimensions');if(u.dims[0]!==h||u.dims[1]!==t.numHeads||u.dims[2]!==m||u.dims[3]!==w)throw new Error('Expect "attention_bias" shape (batch_size, num_heads, sequence_length, total_sequence_length)')}return{batchSize:h,sequenceLength:m,pastSequenceLength:_,kvSequenceLength:y,totalSequenceLength:w,maxSequenceLength:b,inputHiddenSize:0,hiddenSize:g,vHiddenSize:E,headSize:S,vHeadSize:Math.floor(E/t.numHeads),numHeads:t.numHeads,isUnidirectional:!1,pastPresentShareBuffer:!1,maskFilterValue:t.maskFilterValue,maskType:I,scale:t.scale,broadcastResPosBias:A,passPastInKv:k,qkvFormat:v}},gh=e=>fe({...e}),Zi=fe({perm:[0,2,1,3]}),_l=(e,t,r,i,a,s,n)=>{let u=[i,a,s],l=R.size(u),p=[{type:12,data:l},{type:12,data:n},{type:12,data:s}],h=m=>{let g=Q("qkv_with_bias",t.dataType,u),y=N("qkv",t.dataType,u),_=N("bias",r.dataType,u),b=[{name:"output_size",type:"u32"},{name:"bias_offset",type:"u32"},{name:"hidden_size",type:"u32"}];return`
  ${m.registerUniforms(b).declareVariables(y,_,g)}
  ${m.mainStart()}
    ${m.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.output_size")}
    let bias_offset_idx = (global_idx % uniforms.hidden_size) + uniforms.bias_offset;

    qkv_with_bias[global_idx] = qkv[global_idx] + bias[bias_offset_idx];
  }`};return e.compute({name:"MultiHeadAttentionAddBias",shaderCache:{inputDependencies:["type","type"]},getRunData:()=>({outputs:[{dims:u,dataType:t.dataType,gpuDataType:0}],dispatchGroup:{x:Math.ceil(l/64)},programUniforms:p}),getShaderSource:h},{inputs:[t,r],outputs:[-1]})[0]},lr=(e,t,r,i,a,s,n,u)=>{let l=s;if(n&&R.size(n.dims)>0){if(i===1)throw new Error("AddBiasReshape is not implemented. Please export your model with packed QKV or KV");return l=_l(e,s,n,t,i,r*a,u),l=l.reshape([t,i,r,a]),r===1||i===1?l:e.compute(Pe(l,Zi.perm),{inputs:[l],outputs:[-1]})[0]}else return s.dims.length===3&&(l=s.reshape([t,i,r,a])),r===1||i===1?l:e.compute(Pe(l,Zi.perm),{inputs:[l],outputs:[-1]})[0]},yh=(e,t)=>{let r=yl(e.inputs,t),i=e.inputs[0],a=Ce(e.inputs,1),s=Ce(e.inputs,2),n=Ce(e.inputs,3),u=Ce(e.inputs,4),l=Ce(e.inputs,5),p=Ce(e.inputs,6),h=Ce(e.inputs,7);if(i.dims.length===5)throw new Error("Packed QKV is not implemented");if((a==null?void 0:a.dims.length)===5)throw new Error("Packed KV is not implemented");let m=a&&s&&a.dims.length===4&&s.dims.length===4,g=lr(e,r.batchSize,r.numHeads,r.sequenceLength,r.headSize,i,n,0);if(m)return cr(e,g,a,s,u,void 0,p,h,l,r);if(!a||!s)throw new Error("key and value must be provided");let y=lr(e,r.batchSize,r.numHeads,r.kvSequenceLength,r.headSize,a,n,r.hiddenSize),_=lr(e,r.batchSize,r.numHeads,r.kvSequenceLength,r.vHeadSize,s,n,2*r.hiddenSize);cr(e,g,y,_,u,void 0,p,h,l,r)}}),bl,$l,wl,vl,Ia,bh,$h,wh=U(()=>{te(),ie(),xe(),ae(),bl=e=>{if(!e||e.length<1)throw new Error("too few inputs")},$l=(e,t)=>{let r=[],i=t.numOutputs;return e[1].dims[0]>0&&(e[1].getBigInt64Array().forEach(a=>r.push(Number(a))),i=r.length),fe({numOutputs:i,axis:t.axis,splitSizes:r})},wl=e=>`
fn calculateOutputIndex(index: u32) -> u32 {
    for (var i: u32 = 0u; i < ${e}u; i += 1u ) {
    if (index < ${J("uniforms.size_in_split_axis","i",e)}) {
        return i;
    }
    }
    return ${e}u;
}`,vl=e=>{let t=e.length,r=[];for(let i=0;i<t;++i){let a=e[i].setByIndices("indices","input[global_idx]");t===1?r.push(a):i===0?r.push(`if (output_number == ${i}u) { ${a} }`):i===t-1?r.push(`else { ${a} }`):r.push(`else if (output_number == ${i}) { ${a} }`)}return`
      fn writeBufferData(output_number: u32, indices: ${e[0].type.indices}, global_idx: u32) {
        ${r.join(`
`)}
      }`},Ia=(e,t)=>{let r=e[0].dims,i=R.size(r),a=e[0].dataType,s=R.normalizeAxis(t.axis,r.length),n=new Array(t.numOutputs),u=N("input",a,r.length),l=new Array(t.numOutputs),p=[],h=[],m=0,g=[{type:12,data:i}];for(let _=0;_<t.numOutputs;_++){m+=t.splitSizes[_],l[_]=m;let b=r.slice();b[s]=t.splitSizes[_],h.push(b),n[_]=Q(`output${_}`,a,b.length),p.push({dims:h[_],dataType:e[0].dataType})}g.push({type:12,data:l},...ee(r,...h));let y=_=>`
  ${_.registerUniform("input_size","u32").registerUniform("size_in_split_axis","u32",l.length).declareVariables(u,...n)}
  ${wl(l.length)}
  ${vl(n)}

  ${_.mainStart()}
    ${_.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.input_size")}

    var indices = ${u.offsetToIndices("global_idx")};
    var index = ${u.indicesGet("indices",s)};
    let output_number = calculateOutputIndex(index);
    if (output_number != 0) {
      index -= ${J("uniforms.size_in_split_axis","output_number - 1u",l.length)};
      ${u.indicesSet("indices",s,"index")};
    }
    writeBufferData(output_number, indices, global_idx);
  }`;return{name:"Split",shaderCache:{hint:t.cacheKey,inputDependencies:["rank"]},getShaderSource:y,getRunData:()=>({outputs:p,dispatchGroup:{x:Math.ceil(i/64)},programUniforms:g})}},bh=(e,t)=>{bl(e.inputs);let r=e.inputs.length===1?t:$l(e.inputs,t);e.compute(Ia(e.inputs,r),{inputs:[0]})},$h=e=>{let t=e.axis,r=e.splitSizes,i=e.numOutputs<0?r.length:e.numOutputs;if(i!==r.length)throw new Error("numOutputs and splitSizes length must be equal");return fe({axis:t,numOutputs:i,splitSizes:r})}}),xl,jr,vh,xh=U(()=>{te(),ie(),xe(),ae(),xl=(e,t)=>{let[r,i,a,s]=e,{numHeads:n,rotaryEmbeddingDim:u}=t;if(r.dims.length!==3&&r.dims.length!==4)throw new Error(`Input 'x' is expected to have 3 or 4 dimensions, got ${r.dims.length}`);if(!R.areEqual(i.dims,[])&&!R.areEqual(i.dims,[1])&&i.dims.length!==2)throw new Error(`Input 'position_ids' is expected to have 0, 1, or 2 dimensions, got ${i.dims.length}`);if(a.dims.length!==2)throw new Error(`Input 'cos_cache' is expected to have 2 dimensions, got ${a.dims.length}`);if(s.dims.length!==2)throw new Error(`Input 'sin_cache' is expected to have 2 dimensions, got ${s.dims.length}`);if(!R.areEqual(a.dims,s.dims))throw new Error("Inputs 'cos_cache' and 'sin_cache' are expected to have the same shape");if(u>0&&n===0)throw new Error("num_heads must be provided if rotary_embedding_dim is specified");let l=r.dims[0],p=r.dims[r.dims.length-2],h=a.dims[0],m=R.sizeFromDimension(r.dims,1)/p,g=u===0?a.dims[1]*2:m/n;if(u>g)throw new Error("rotary_embedding_dim must be less than or equal to head_size");if(i.dims.length===2){if(l!==i.dims[0])throw new Error(`Input 'position_ids' dimension 0 should be of size batch_size, got ${i.dims[0]}`);if(p!==i.dims[1])throw new Error(`Input 'position_ids' dimension 1 should be of size sequence_length, got ${i.dims[1]}`)}if(p>h)throw new Error("Updating cos_cache and sin_cache in RotaryEmbedding is not currently supported");if(g/2!==a.dims[1]&&u/2!==a.dims[1])throw new Error(`Input 'cos_cache' dimension 1 should be same as head_size / 2 or rotary_embedding_dim / 2, got ${a.dims[1]}`)},jr=(e,t)=>{let{interleaved:r,numHeads:i,rotaryEmbeddingDim:a,scale:s}=t,n=e[0].dims[0],u=R.sizeFromDimension(e[0].dims,1),l=e[0].dims[e[0].dims.length-2],p=u/l,h=e[2].dims[1],m=a===0?h*2:p/i,g=new Array(n,l,p/m,m-h),y=R.computeStrides(g),_=[{type:1,data:s},{type:12,data:g},{type:12,data:y},...e[0].dims.length===3?new Array({type:12,data:[u,p,m,1]}):[],...e[0].dims.length===4?new Array({type:12,data:[u,m,l*m,1]}):[],...ee(e[0].dims,e[1].dims,e[2].dims,e[3].dims,e[0].dims)],b=S=>{let v=N("input",e[0].dataType,e[0].dims.length),w=N("position_ids",e[1].dataType,e[1].dims.length),I=N("cos_cache",e[2].dataType,e[2].dims.length),k=N("sin_cache",e[3].dataType,e[3].dims.length),E=Q("output",e[0].dataType,e[0].dims.length);return S.registerUniforms([{name:"scale",type:"f32"},{name:"global_shape",type:"u32",length:g.length},{name:"global_strides",type:"u32",length:y.length},{name:"input_output_strides",type:"u32",length:y.length}]),`
        ${S.declareVariables(v,w,I,k,E)}

        ${S.mainStart(Vt)}
          let half_rotary_emb_dim = uniforms.${I.name}_shape[1];
          let bsnh = global_idx / uniforms.global_strides % uniforms.global_shape;
          let size = uniforms.global_shape[0] * uniforms.global_strides[0];
          ${S.guardAgainstOutOfBoundsWorkgroupSizes("size")}

          if (bsnh[3] < half_rotary_emb_dim) {
            let position_ids_idx =
                ${w.broadcastedIndicesToOffset("bsnh.xy",Q("",w.type.tensor,2))};
            let position_id =
                u32(${w.getByOffset("position_ids_idx")}) + select(0, bsnh[1], position_ids_idx == 0);
            let i = dot(bsnh, uniforms.input_output_strides) + select(0, bsnh[3], ${r});
            let j = i + select(half_rotary_emb_dim, 1, ${r});
            let re = ${v.getByOffset("i")} * ${I.get("position_id","bsnh[3]")} -
                ${v.getByOffset("j")} * ${k.get("position_id","bsnh[3]")};
            ${E.setByOffset("i","re")}
            let im = ${v.getByOffset("i")} * ${k.get("position_id","bsnh[3]")} +
                ${v.getByOffset("j")} * ${I.get("position_id","bsnh[3]")};
            ${E.setByOffset("j","im")}
          } else {
            let k = dot(bsnh, uniforms.input_output_strides) + half_rotary_emb_dim;
            ${E.setByOffset("k",v.getByOffset("k"))}
          }
        }`};return{name:"RotaryEmbedding",shaderCache:{hint:fe({interleaved:r}).cacheKey,inputDependencies:["rank","rank","rank","rank"]},getShaderSource:b,getRunData:()=>({outputs:[{dims:e[0].dims,dataType:e[0].dataType}],dispatchGroup:{x:Math.ceil(R.size(g)/Vt)},programUniforms:_})}},vh=(e,t)=>{xl(e.inputs,t),e.compute(jr(e.inputs,t))}}),Sl,kl,Xi,Tl,Sh,k0=U(()=>{xe(),te(),Ga(),_h(),wh(),_t(),xh(),ae(),Sl=(e,t)=>{if(t.doRotary&&e.length<=7)throw new Error("cos_cache and sin_cache inputs are required if do_rotary is specified");let r=e[0],i=e[1],a=e[2],s=e[3],n=e[4];if(t.doRotary!==0&&e.length<=7)throw new Error("cos_cast and sin_cache are expected if do_rotary attribute is non-zero");if(t.localWindowSize!==-1)throw new Error("Local attention is not supported");if(t.softcap!==0)throw new Error("Softcap is not supported");if(t.rotaryInterleaved!==0)throw new Error("Rotary interleaved is not supported");if(t.smoothSoftmax)throw new Error("Smooth softmax is not supported");if(r.dims.length!==3&&r.dims.length!==5)throw new Error("Input query is expected to have 3 or 5 dimensions");let u=!1,l=r.dims[0],p=r.dims[1],h=r.dims.length===3?u?r.dims[2]/3:r.dims[2]:t.numHeads*r.dims[4],m=p,g=0,y=!i||i.dims.length===0,_=Math.floor(y?h/(t.numHeads+2*t.kvNumHeads):h/t.numHeads);y&&(h=_*t.numHeads);let b=s&&s.dims.length!==0,S=n&&n.dims.length!==0;if(b&&s.dims.length===4&&s.dims[0]===l&&s.dims[1]!==t.kvNumHeads&&s.dims[2]===t.kvNumHeads&&s.dims[3]===_)throw new Error("BSNH pastKey/pastValue is not supported");if(b&&S){if(s.dims.length!==4)throw new Error('Input "past_key" is expected to have 4 dimensions');if(n.dims.length!==4)throw new Error('Input "past_value" is expected to have 4 dimensions');g=s.dims[2]}else if(b||S)throw new Error('Input "past_key" and "past_value" shall be both present or both absent');let v=1;if(i&&i.dims.length>0){if(r.dims.length!==3)throw new Error('Input "query" is expected to have 3 dimensions when key is given');if(i.dims.length<3||i.dims.length>5)throw new Error('Input "key" is expected to have 3, 4, or 5 dimensions');if(r.dims[0]!==i.dims[0])throw new Error('Input "query" and "key" shall have same dim 0 (batch size)');if(i.dims.length===3){if(r.dims[2]%i.dims[2]!==0)throw new Error('Dimension 2 of "query" should be a multiple of "key"');m=i.dims[1]}else if(i.dims.length===5){if(i.dims[2]!==t.numHeads||i.dims[3]!==2||i.dims[4]!==_)throw new Error('Expect "key" shape (batch_size, kv_sequence_length, num_heads, 2, head_size) for packed kv');if(a)throw new Error('Expect "value" be none when "key" has packed kv format.');m=i.dims[1]}else{if(i.dims[1]!==t.numHeads||i.dims[3]!==_)throw new Error('Expect "key" shape (batch_size, num_heads, kv_sequence_length, head_size) for past_key');m=i.dims[2]}}else{if(r.dims.length!==3&&r.dims.length!==5)throw new Error('Input "query" is expected to have 3 or 5 dimensions when key is empty');if(r.dims.length===5&&(r.dims[2]!==t.numHeads||r.dims[3]!==3))throw new Error('Expect "query" shape (batch_size, kv_sequence_length, num_heads, 3, head_size) for packed kv');v=3}let w=0,I=!1,k=t.kvNumHeads?_*t.kvNumHeads:h;if(a&&a.dims.length>0){if(a.dims.length!==3&&a.dims.length!==4)throw new Error('Input "value" is expected to have 3 or 4 dimensions');if(r.dims[0]!==a.dims[0])throw new Error('Input "query" and "value" shall have same dim 0 (batch_size)');if(a.dims.length===3){if(m!==a.dims[1])throw new Error('Input "key" and "value" shall have the same dim 1 (kv_sequence_length)');k=a.dims[2]}else{if(m!==a.dims[2])throw new Error('Input "past_key" and "past_value" shall have the same dim 2 (kv_sequence_length)');k=a.dims[1]*a.dims[3],I=!0}}let E=e.length>4?e[5]:void 0;if(E){if(E.dims.length===0)throw new Error("seqlens_k must be at least 1D, got scalar.");let A=E.dims.reduce((C,x)=>C*x,1);if(A!==l)throw new Error(`seqlens_k must have batch_size (${l}) elements, got ${A}.`);for(let C=0;C<E.dims.length;C++)if(E.dims[C]!==1&&E.dims[C]!==l)throw new Error(`seqlens_k has unexpected shape. Each dimension must be 1 or batch_size (${l}), got dims[${C}] = ${E.dims[C]}.`)}return{batchSize:l,sequenceLength:p,pastSequenceLength:g,kvSequenceLength:m,totalSequenceLength:-1,maxSequenceLength:-1,inputHiddenSize:0,hiddenSize:h,vHiddenSize:k,headSize:_,vHeadSize:Math.floor(k/t.kvNumHeads),numHeads:t.numHeads,kvNumHeads:t.kvNumHeads,nReps:t.numHeads/t.kvNumHeads,pastPresentShareBuffer:!1,maskType:w,scale:t.scale,broadcastResPosBias:!1,passPastInKv:I,qkvFormat:v}},kl=fe({perm:[0,2,1,3]}),Xi=(e,t,r)=>{let i=t,a=r.kvNumHeads;return t.dims.length===3&&r.kvSequenceLength!==0&&(i=t.reshape([r.batchSize,r.kvSequenceLength,a,r.headSize]),i=e.compute(Pe(i,kl.perm),{inputs:[i],outputs:[-1]})[0]),i},Tl=(e,t,r,i)=>{let a=7,s=["type","type"],n=[e*t],u=e*t,l=[{type:12,data:u},{type:12,data:t},{type:12,data:e}],p=h=>{let m=N("seq_lens",r.dataType,r.dims),g=N("total_seq_lens",i.dataType,i.dims),y=Q("pos_ids",a,n),_=[{name:"output_size",type:"u32"},{name:"sequence_length",type:"u32"},{name:"batch_size",type:"u32"}];return`
  ${h.registerUniforms(_).declareVariables(m,g,y)}
  ${h.mainStart()}
    ${h.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.output_size")}
    let total_sequence_length = u32(${g.getByOffset("0")});
    let is_subsequent_prompt = uniforms.sequence_length > 1 && uniforms.sequence_length != total_sequence_length;
    let is_first_prompt = !is_subsequent_prompt && uniforms.sequence_length == total_sequence_length;
    let batch_idx = global_idx / uniforms.sequence_length;
    let sequence_idx = i32(global_idx % uniforms.sequence_length);
    var pos_id: i32 = 0;
    let seqlen = ${m.getByOffset("batch_idx")};
    let total_seqlen = seqlen + 1;
    if (is_first_prompt) {
      if (sequence_idx < total_seqlen) {
        pos_id = sequence_idx;
      } else {
        pos_id = 1;
      }
      ${y.setByOffset("global_idx","pos_id")}
    } else if (is_subsequent_prompt) {
      let past_seqlen = total_seqlen - i32(uniforms.sequence_length);
      if (past_seqlen + sequence_idx < total_seqlen) {
        pos_id = past_seqlen + sequence_idx;
      } else {
        pos_id = 1;
      }
      ${y.setByOffset("global_idx","pos_id")}
    } else if (global_idx < uniforms.batch_size) {
      ${y.setByOffset("global_idx","seqlen")}
    };
  }
  `};return{name:"GeneratePositionIds",shaderCache:{hint:`${e};${t}`,inputDependencies:s},getRunData:()=>({outputs:[{dims:n,dataType:a}],dispatchGroup:{x:Math.ceil(u/64)},programUniforms:l}),getShaderSource:p}},Sh=(e,t)=>{var k;let r=Sl(e.inputs,t);if(e.inputs[0].dims.length===5)throw new Error("Packed QKV is not implemented");if(((k=e.inputs[1])==null?void 0:k.dims.length)===5)throw new Error("Packed KV is not implemented");let i=e.inputs[0],a=e.inputs[1]&&e.inputs[1].dims.length>0?e.inputs[1]:void 0,s=e.inputs[2]&&e.inputs[2].dims.length>0?e.inputs[2]:void 0,n=e.inputs[3]&&e.inputs[3].dims.length!==0?e.inputs[3]:void 0,u=e.inputs[4]&&e.inputs[4].dims.length!==0?e.inputs[4]:void 0,l=e.inputs.length>4?e.inputs[5]:void 0,p=e.inputs.length>5?e.inputs[6]:void 0,h=r.kvNumHeads?r.kvNumHeads:r.numHeads,m=fe({axis:2,numOutputs:3,splitSizes:[r.numHeads*r.headSize,h*r.headSize,h*r.headSize]}),[g,y,_]=!a&&!s?e.compute(Ia([i],m),{inputs:[i],outputs:[-1,-1,-1]}):[i,a,s],b,S;if(t.doRotary){let E=e.compute(Tl(r.batchSize,r.sequenceLength,l,p),{inputs:[l,p],outputs:[-1]})[0],A=e.inputs[7],C=e.inputs[8],x=fe({interleaved:t.rotaryInterleaved!==0,numHeads:r.numHeads,rotaryEmbeddingDim:0,scale:t.scale}),D=[g,E,A,C],M=[-1];b=e.compute(jr(D,x),{inputs:D,outputs:M})[0],D.splice(0,1,y);let P=fe({interleaved:t.rotaryInterleaved!==0,numHeads:r.kvNumHeads,rotaryEmbeddingDim:0,scale:t.scale});S=e.compute(jr(D,P),{inputs:D,outputs:M})[0]}let v=lr(e,r.batchSize,r.numHeads,r.sequenceLength,r.headSize,t.doRotary?b:g,void 0,0),w=Xi(e,t.doRotary?S:y,r),I=Xi(e,_,r);cr(e,v,w,I,void 0,void 0,n,u,void 0,r,l,p)}}),Qi,Il,El,kh,T0=U(()=>{te(),ie(),_t(),ae(),Qi=(e,t,r,i,a,s,n,u)=>{let l=ve(s),p=l===1?"f32":`vec${l}f`,h=l===1?"vec2f":`mat2x${l}f`,m=a*n,g=64;m===1&&(g=256);let y=[a,n,s/l],_=[a,n,2],b=["rank","type","type"],S=[];S.push(...ee(y,_));let v=w=>{let I=N("x",t.dataType,3,l),k=N("scale",r.dataType,r.dims),E=N("bias",i.dataType,i.dims),A=Q("output",1,3,2),C=[I,k,E,A];return`
  var<workgroup> workgroup_shared : array<${h}, ${g}>;
  const workgroup_size = ${g}u;
  ${w.declareVariables(...C)}
  ${w.mainStart(g)}
    let batch = workgroup_index / uniforms.x_shape[1];
    let channel = workgroup_index % uniforms.x_shape[1];
    let hight = uniforms.x_shape[2];
    // initialize workgroup memory
    var sum = ${p}(0);
    var squared_sum = ${p}(0);
    for (var h = local_idx; h < hight; h += workgroup_size) {
      let value = ${p}(${I.get("batch","channel","h")});
      sum += value;
      squared_sum += value * value;
    }
    workgroup_shared[local_idx] = ${h}(sum, squared_sum);
    workgroupBarrier();

    for (var currSize = workgroup_size >> 1;  currSize > 0; currSize = currSize >> 1) {
      if (local_idx < currSize) {
        workgroup_shared[local_idx] = workgroup_shared[local_idx] + workgroup_shared[local_idx + currSize];
      }
      workgroupBarrier();
    }
    if (local_idx == 0) {
      let sum_final = ${yt("workgroup_shared[0][0]",l)} / f32(hight * ${l});
      let squared_sum_final = ${yt("workgroup_shared[0][1]",l)} / f32(hight * ${l});

      let inv_std_dev = inverseSqrt(squared_sum_final - sum_final * sum_final + f32(${u}));
      let channel_scale = inv_std_dev * f32(scale[channel]);
      let channel_shift = f32(bias[channel]) - sum_final * channel_scale;
      output[workgroup_index] = vec2f(channel_scale, channel_shift);
    }
  }`};return e.compute({name:"InstanceNormComputeChannelScaleShift",shaderCache:{hint:`${l};${u};${g}`,inputDependencies:b},getRunData:()=>({outputs:[{dims:_,dataType:1}],dispatchGroup:{x:m},programUniforms:S}),getShaderSource:v},{inputs:[t,r,i],outputs:[-1]})[0]},Il=(e,t,r)=>{let i=t[0].dims,a=i,s=2,n=i[0],u=i[1],l=R.sizeFromDimension(i,s),p=ve(l),h=R.size(a)/p,m=Qi(e,t[0],t[1],t[2],n,l,u,r.epsilon),g=[n,u,l/p],y=[n,u],_=["type","none"],b=S=>{let v=N("x",t[0].dataType,g.length,p),w=N("scale_shift",1,y.length,2),I=Q("output",t[0].dataType,g.length,p),k=[v,w,I];return`
  ${S.registerUniform("output_size","u32").declareVariables(...k)}
  ${S.mainStart()}
  ${S.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.output_size")}
      let outputIndices = ${I.offsetToIndices("global_idx")};
      let batch = outputIndices[0];
      let channel = outputIndices[1];
      let scale_shift = ${w.getByIndices("vec2<u32>(batch, channel)")};
      let value = ${v.getByOffset("global_idx")} * ${I.type.value}(scale_shift.x) + ${I.type.value}(scale_shift.y);
      ${I.setByOffset("global_idx","value")};
  }`};e.compute({name:"InstanceNormalization",shaderCache:{hint:`${p}`,inputDependencies:_},getRunData:()=>({outputs:[{dims:a,dataType:t[0].dataType}],dispatchGroup:{x:Math.ceil(h/64)},programUniforms:[{type:12,data:h},...ee(g,y,g)]}),getShaderSource:b},{inputs:[t[0],m]})},El=(e,t,r)=>{let i=t[0].dims,a=i,s=i[0],n=i[i.length-1],u=R.sizeFromDimension(i,1)/n,l=ve(n),p=R.size(a)/l,h=[{type:12,data:u},{type:12,data:Math.floor(n/l)}],m=["type","type"],g=!1,y=[0,i.length-1];for(let v=0;v<i.length-2;v++)g=g||i[v+1]!==1,y.push(v+1);g=g&&i[i.length-1]!==1;let _=g?e.compute(Pe(e.inputs[0],y),{inputs:[e.inputs[0]],outputs:[-1]})[0]:e.inputs[0].reshape(Array.from({length:i.length},(v,w)=>i[y[w]])),b=Qi(e,_,t[1],t[2],s,u,n,r.epsilon),S=v=>{let w=Te(t[0].dataType),I=l===1?"vec2f":`mat${l}x2f`,k=C=>{let x=C===0?"x":"y",D=l===1?"f32":`vec${l}f`;switch(l){case 1:return`${w}(${D}(scale.${x}))`;case 2:return`vec2<${w}>(${D}(scale[0].${x}, scale[1].${x}))`;case 4:return`vec4<${w}>(${D}(scale[0].${x}, scale[1].${x}, scale[2].${x}, scale[3].${x}))`;default:throw new Error(`Not supported compoents ${l}`)}},E=N("input",t[0].dataType,t[0].dims,l),A=Q("output",t[0].dataType,a,l);return`
  @group(0) @binding(0) var<storage, read> input : array<${E.type.storage}>;
  @group(0) @binding(1) var<storage, read> scale_input : array<${I}>;
  @group(0) @binding(2) var<storage, read_write> output : array<${A.type.storage}>;
  struct Uniforms {H: u32, C : u32};
  @group(0) @binding(3) var<uniform> uniforms: Uniforms;

  ${v.mainStart()}
    let current_image_number = global_idx / (uniforms.C * uniforms.H);
    let current_channel_number = global_idx % uniforms.C;

    let scale_offset = current_image_number * uniforms.C + current_channel_number;
    let scale = scale_input[scale_offset];
    output[global_idx] = fma(input[global_idx], ${k(0)}, ${k(1)});
  }`};e.compute({name:"InstanceNormalizationNHWC",shaderCache:{hint:`${l}`,inputDependencies:m},getRunData:()=>({outputs:[{dims:a,dataType:t[0].dataType}],dispatchGroup:{x:Math.ceil(p/64)},programUniforms:h}),getShaderSource:S},{inputs:[t[0],b]})},kh=(e,t)=>{t.format==="NHWC"?El(e,e.inputs,t):Il(e,e.inputs,t)}}),zl,Cl,Th,I0=U(()=>{te(),ie(),ae(),zl=e=>{if(!e||e.length<2)throw new Error("layerNorm requires at least 2 inputs.")},Cl=(e,t,r)=>{let i=t.simplified,a=e[0].dims,s=e[1],n=!i&&e[2],u=a,l=R.normalizeAxis(t.axis,a.length),p=R.sizeToDimension(a,l),h=R.sizeFromDimension(a,l),m=R.size(s.dims),g=n?R.size(n.dims):0;if(m!==h||n&&g!==h)throw new Error(`Size of X.shape()[axis:] == ${h}.
       Size of scale and bias (if provided) must match this.
       Got scale size of ${m} and bias size of ${g}`);let y=[];for(let E=0;E<a.length;++E)E<l?y.push(a[E]):y.push(1);let _=ve(h),b=["type","type"],S=[{type:12,data:p},{type:1,data:h},{type:12,data:Math.floor(h/_)},{type:1,data:t.epsilon}];n&&b.push("type");let v=r>1,w=r>2,I=E=>{let A=Te(e[0].dataType),C=[N("x",e[0].dataType,e[0].dims,_),N("scale",s.dataType,s.dims,_)];n&&C.push(N("bias",n.dataType,n.dims,_)),C.push(Q("output",e[0].dataType,u,_)),v&&C.push(Q("mean_data_output",1,y)),w&&C.push(Q("inv_std_output",1,y));let x=[{name:"norm_count",type:"u32"},{name:"norm_size",type:"f32"},{name:"norm_size_vectorized",type:"u32"},{name:"epsilon",type:"f32"}];return`
  ${E.registerUniforms(x).declareVariables(...C)}
  ${E.mainStart()}
    ${E.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.norm_count")}
    let offset = global_idx * uniforms.norm_size_vectorized;
    var mean_vector = ${_a("f32",_)};
    var mean_square_vector = ${_a("f32",_)};

    for (var h: u32 = 0u; h < uniforms.norm_size_vectorized; h++) {
      let value = ${Lt(A,_,"x[h + offset]")};
      mean_vector += value;
      mean_square_vector += value * value;
    }
    let mean = ${yt("mean_vector",_)} / uniforms.norm_size;
    let inv_std_dev = inverseSqrt(${yt("mean_square_vector",_)} / uniforms.norm_size ${i?"":"- mean * mean"} + uniforms.epsilon);

    for (var j: u32 = 0; j < uniforms.norm_size_vectorized; j++) {
      let f32input = ${Lt(A,_,"x[j + offset]")};
      let f32scale = ${Lt(A,_,"scale[j]")};
      output[j + offset] = ${C[0].type.value}((f32input ${i?"":"- mean"}) * inv_std_dev * f32scale
        ${n?`+ ${Lt(A,_,"bias[j]")}`:""}
      );
    }

    ${v?"mean_data_output[global_idx] = mean":""};
    ${w?"inv_std_output[global_idx] = inv_std_dev":""};
  }`},k=[{dims:u,dataType:e[0].dataType}];return v&&k.push({dims:y,dataType:1}),w&&k.push({dims:y,dataType:1}),{name:"LayerNormalization",shaderCache:{hint:`${_};${r};${i}`,inputDependencies:b},getRunData:()=>({outputs:k,dispatchGroup:{x:Math.ceil(p/64)},programUniforms:S}),getShaderSource:I}},Th=(e,t)=>{zl(e.inputs),e.compute(Cl(e.inputs,t,e.outputCount))}}),Al,Ih,E0=U(()=>{ie(),Za(),Xa(),Al=e=>{if(!e||e.length!==2)throw new Error("MatMul requires 2 inputs.");if(e[0].dims[e[0].dims.length-1]!==e[1].dims[e[1].dims.length-2])throw new Error("shared dimension does not match.")},Ih=e=>{Al(e.inputs);let t=Wt.calcShape(e.inputs[0].dims,e.inputs[1].dims,!0);if(!t)throw new Error("Can't use matmul on the given tensors");let r=t[t.length-1],i=e.inputs[0].dims[e.inputs[0].dims.length-1];if(r<8&&i<8)e.compute(Ka(e.inputs,{activation:""},t));else{let a=t[t.length-2],s=R.size(e.inputs[0].dims.slice(0,-2)),n=R.size(e.inputs[1].dims.slice(0,-2));if(s!==1&&a===1&&n===1){let u=e.inputs[0].reshape([1,s,i]),l=e.inputs[1].reshape([1,i,r]),p=[1,s,r],h=[u,l];e.compute(Fr(h,{activation:""},t,p),{inputs:h})}else e.compute(Fr(e.inputs,{activation:""},t))}}}),Ol,Rl,Bl,Eh,zh,z0=U(()=>{te(),ie(),xe(),ae(),Ol=(e,t)=>{if(e.length<3||e.length>4)throw new Error("MatMulNBits requires 3 or 4 inputs");let r=e[0],i=r.dims.length;if(r.dims[i-1]!==t.k)throw new Error("The last dim of input shape does not match the k value");let a=Math.floor((t.k+t.blockSize-1)/t.blockSize),s=t.blockSize/8*t.bits,n=e[1];if(!R.areEqual(n.dims,[t.n,a,s]))throw new Error("The second inputs must be 3D tensor with shape N X nBlocksPerCol X blobSize");let u=e[2].dims;if(R.size(u)!==t.n*a)throw new Error("scales input size error.");if(e.length===4){let l=e[3].dims,p=t.n*(t.bits===8?a:Math.floor((a*t.bits+7)/8));if(R.size(l)!==p)throw new Error("zeroPoints input size error.")}},Rl=(e,t)=>{let r=e[0].dims,i=r.length,a=r[i-2],s=t.k,n=t.n,u=r.slice(0,i-2),l=R.size(u),p=e[1].dims[2]/4,h=e[0].dataType,m=ve(t.k),g=ve(p),y=ve(n),_=u.concat([a,n]),b=a>1&&n/y%2===0?2:1,S=R.size(_)/y/b,v=64,w=[],I=[l,a,s/m],k=R.convertShape(e[1].dims).slice();k.splice(-1,1,p/g),w.push(...ee(I)),w.push(...ee(k)),w.push(...ee(e[2].dims)),e.length===4&&w.push(...ee(R.convertShape(e[3].dims)));let E=[l,a,n/y];w.push(...ee(E));let A=C=>{let x=I.length,D=N("a",e[0].dataType,x,m),M=N("b",12,k.length,g),P=N("scales",e[2].dataType,e[2].dims.length),K=[D,M,P],Z=e.length===4?N("zero_points",12,e[3].dims.length):void 0;Z&&K.push(Z);let O=E.length,G=Q("output",e[0].dataType,O,y),F=Te(e[0].dataType),Y=(()=>{switch(m){case 1:return`array<${F}, 8>`;case 2:return`mat4x2<${F}>`;case 4:return`mat2x4<${F}>`;default:throw new Error(`${m}-component is not supported.`)}})(),he=Math.floor(32/t.bits),V=Math.floor(he/8),se=()=>{let X="";for(let L=0;L<V;L++){let me=L*t.bits*4,qe=me+t.bits;X+=`
          // reuse a data (pass ${L})
            var input_offset${L>0?L:""} = ${L===0?D.indicesToOffset(`${D.type.indices}(batch, row, word_offset)`):"input_offset"};
            var a_data${L>0?L:""}: ${Y};
            for (var j${L>0?L:""}: u32 = 0; j${L>0?L:""} < ${8/m}; j${L>0?L:""}++) {
              a_data${L>0?L:""}[j${L>0?L:""}] = ${D.getByOffset(`input_offset${L>0?L:""}`)};
              input_offset${L>0?L:""}++;
            }
          `;for(let Se=0;Se<y*b;Se++)X+=`
            b_value = ${g===1?`b${Se}_data`:`b${Se}_data[i]`};
            ${t.bits===2?`{
              let half_word = b_value >> ${L*16}u;
              let byte_lo = half_word & 0xFFu;
              let byte_hi = (half_word >> 8u) & 0xFFu;
              let spread_word = (byte_lo & 0xFu) | ((byte_lo >> 4u) << 8u) | ((byte_hi & 0xFu) << 16u) | ((byte_hi >> 4u) << 24u);
              b_value_lower = unpack4xU8(spread_word & b_mask);
              b_value_upper = unpack4xU8((spread_word >> 2u) & b_mask);
            }`:`b_value_lower = unpack4xU8((b_value >> ${me}u) & b_mask);
            b_value_upper = unpack4xU8((b_value >> ${qe}u) & b_mask);`}
            b_quantized_values = ${Y}(${Array.from({length:4},(Ae,Oe)=>`${F}(b_value_lower[${Oe}]), ${F}(b_value_upper[${Oe}])`).join(", ")});
            b_dequantized_values = ${m===1?`${Y}(${Array.from({length:8},(Ae,Oe)=>`(b_quantized_values[${Oe}] - ${Z?`zero_point${Se}`:"zero_point"}) * scale${Se}`).join(", ")});`:`(b_quantized_values - ${Y}(${Array(8).fill(`${Z?`zero_point${Se}`:"zero_point"}`).join(",")})) * scale${Se};`};
            workgroup_shared[local_id.x * ${b} + ${Math.floor(Se/y)}]${y>1?`[${Se%y}]`:""} += ${Array.from({length:8/m},(Ae,Oe)=>`${m===1?`a_data${L>0?L:""}[${Oe}] * b_dequantized_values[${Oe}]`:`dot(a_data${L>0?L:""}[${Oe}], b_dequantized_values[${Oe}])`}`).join(" + ")};
          `}return X},q=()=>{let X=`
            var col_index = col * ${y};
            ${Z?`
            let zero_point_values_per_byte: u32 = ${Math.floor(8/t.bits)}u;
            let zero_point_bytes_per_col = (nBlocksPerCol + zero_point_values_per_byte - 1u) / zero_point_values_per_byte;
            var zero_point_byte_count: u32;
            var zero_point_word_index: u32;
            var zero_point_byte_offset: u32;
            let zero_point_sub_offset: u32 = block % zero_point_values_per_byte;
            var zero_point_bits_offset: u32;
            var zero_point_word: u32;`:`
            // The default zero point is ${Math.pow(2,t.bits-1)} for unsigned ${t.bits}-bit quantization.
            let zero_point = ${F}(${Math.pow(2,t.bits-1).toFixed(1)});`}
            `;for(let L=0;L<y*b;L++)X+=`
            let scale${L} = ${P.getByOffset("col_index * nBlocksPerCol + block")};
            ${Z?`
            zero_point_byte_count = col_index * zero_point_bytes_per_col + (block / zero_point_values_per_byte);
            zero_point_word_index = zero_point_byte_count >> 0x2u;
            zero_point_byte_offset = zero_point_byte_count & 0x3u;
            zero_point_bits_offset = (zero_point_byte_offset << 3) + (zero_point_sub_offset * ${t.bits}u);
            zero_point_word = ${Z.getByOffset("zero_point_word_index")} >> zero_point_bits_offset;
            let zero_point${L} = ${F}((zero_point_word) & ${t.bits===2?"0x3u":"0xFu"});`:""}
            col_index += 1;`;return X},H=()=>{let X=`col_index = col * ${y};`;for(let L=0;L<y*b;L++)X+=`
            let b${L}_data = ${M.getByIndices(`${M.type.indices}(col_index, block, word)`)};
            col_index += 1;`;return X+=`
            var b_value: u32;
            let b_mask: u32 = ${t.bits===2?"0x03030303u":"0x0F0F0F0Fu"};
            var b_value_lower: vec4<u32>;
            var b_value_upper: vec4<u32>;
            var b_quantized_values: ${Y};
            var b_dequantized_values: ${Y};`,X};return`
        var<workgroup> workgroup_shared: array<${G.type.value}, ${b*v}>;
        ${C.declareVariables(...K,G)}
        ${C.mainStart([v,1,1])}
          let output_indices = ${G.offsetToIndices(`(global_idx / ${v}) * ${b}`)};
          let col = output_indices[2];
          let row = output_indices[1];
          let batch = output_indices[0];
          let nBlocksPerCol = uniforms.b_shape[1];

          for (var block = local_id.x; block < nBlocksPerCol; block += ${v}) {
            //process one block
            var word_offset: u32 = block * ${t.blockSize/m};
            ${q()}
            for (var word: u32 = 0; word < ${p}; word += ${g}) {
              ${H()}
              for (var i: u32 = 0; i < ${g}; i++) {
                ${se()}
                word_offset += ${he/m};
              }
            }
          }
          workgroupBarrier();

          if (local_id.x < ${b}) {
            var output_value: ${G.type.value} = ${G.type.value}(0);
            var workgroup_shared_offset: u32 = local_id.x;
            for (var b: u32 = 0u; b < ${v}u; b++) {
              output_value += workgroup_shared[workgroup_shared_offset];
              workgroup_shared_offset += ${b};
            }
            ${G.setByIndices(`${G.type.indices}(batch, row, col + local_id.x)`,"output_value")};
          }
        }`};return{name:"MatMulNBits",shaderCache:{hint:`${t.blockSize};${t.bits};${m};${g};${y};${b};${v}`,inputDependencies:Array(e.length).fill("rank")},getRunData:()=>({outputs:[{dims:_,dataType:h}],dispatchGroup:{x:S},programUniforms:w}),getShaderSource:A}},Bl=(e,t)=>{let r=e[0].dims,i=r.length,a=r[i-2],s=t.k,n=t.n,u=r.slice(0,i-2),l=R.size(u),p=e[1].dims[2]/4,h=e[0].dataType,m=ve(t.k),g=ve(p),y=u.concat([a,n]),_=128,b=n%8===0?8:n%4===0?4:1,S=_/b,v=Math.floor(32/t.bits),w=S*g*v,I=w/m,k=w/t.blockSize,E=R.size(y)/b,A=[],C=[l,a,s/m],x=R.convertShape(e[1].dims).slice();x.splice(-1,1,p/g),A.push(...ee(C)),A.push(...ee(x)),A.push(...ee(e[2].dims)),e.length===4&&A.push(...ee(R.convertShape(e[3].dims)));let D=[l,a,n];A.push(...ee(D));let M=P=>{let K=C.length,Z=N("a",e[0].dataType,K,m),O=N("b",12,x.length,g),G=N("scales",e[2].dataType,e[2].dims.length),F=[Z,O,G],Y=e.length===4?N("zero_points",12,e[3].dims.length):void 0;Y&&F.push(Y);let he=D.length,V=Q("output",e[0].dataType,he),se=Te(e[0].dataType),q=()=>{switch(m){case 1:return`
          let a_data0 = vec4<${se}>(sub_a[word_offset], sub_a[word_offset + 1], sub_a[word_offset + 2], sub_a[word_offset + 3]);
          let a_data1 = vec4<${se}>(sub_a[word_offset + 4], sub_a[word_offset + 5], sub_a[word_offset + 6], sub_a[word_offset + 7]);`;case 2:return`
          let a_data0 = vec4<${se}>(sub_a[word_offset], sub_a[word_offset + 1]);
          let a_data1 = vec4<${se}>(sub_a[word_offset + 2], sub_a[word_offset + 3]);`;case 4:return`
          let a_data0 = sub_a[word_offset];
          let a_data1 = sub_a[word_offset + 1];`;default:throw new Error(`${m}-component is not supported.`)}};return`
        var<workgroup> sub_a: array<${Z.type.value}, ${I}>;
        var<workgroup> inter_results: array<array<${V.type.value}, ${S}>, ${b}>;
        ${P.declareVariables(...F,V)}
        ${P.mainStart([S,b,1])}
          let output_indices = ${V.offsetToIndices(`workgroup_index * ${b}`)};
          let col = output_indices[2];
          let row = output_indices[1];
          let batch = output_indices[0];
          let n_blocks_per_col = uniforms.b_shape[1];
          let num_tiles =  (n_blocks_per_col - 1) / ${k} + 1;

          // Loop over shared dimension.
          for (var tile: u32 = 0; tile < num_tiles; tile += 1) {
            let a_col_start = tile * ${I};
            // load one tile A data into shared memory.
            for (var a_offset = local_idx; a_offset < ${I}; a_offset += ${_})
            {
              let a_col = a_col_start + a_offset;
              if (a_col < uniforms.a_shape[2])
              {
                sub_a[a_offset] = ${Z.getByIndices(`${Z.type.indices}(batch, row, a_col)`)};
              } else {
                sub_a[a_offset] = ${Z.type.value}(0);
              }
            }
            workgroupBarrier();

            // each thread process one block
            let b_row = col + local_id.y;
            let block = tile * ${k} + local_id.x;
            ${Y?`
            let zero_point_values_per_byte: u32 = ${Math.floor(8/t.bits)}u;
            let zero_point_bytes_per_col = (n_blocks_per_col + zero_point_values_per_byte - 1u) / zero_point_values_per_byte;
            let zero_point_byte_count = b_row * zero_point_bytes_per_col + (block / zero_point_values_per_byte);
            let zero_point_word_index = zero_point_byte_count >> 0x2u;
            let zero_point_byte_offset = zero_point_byte_count & 0x3u;
            let zero_point_sub_offset: u32 = block % zero_point_values_per_byte;
            let zero_point_bits_offset = (zero_point_byte_offset << 3) + (zero_point_sub_offset * ${t.bits}u);
            let zero_point_word = ${Y.getByOffset("zero_point_word_index")} >> zero_point_bits_offset;
            let zero_point = ${se}((zero_point_word) & ${t.bits===2?"0x3u":"0xFu"});`:`
            // The default zero point is ${Math.pow(2,t.bits-1)} for unsigned ${t.bits}-bit quantization.
            let zero_point = ${se}(${Math.pow(2,t.bits-1).toFixed(1)});`}
            let scale = ${G.getByOffset("b_row * n_blocks_per_col + block")};
            let b_data = ${O.getByIndices(`${O.type.indices}(b_row, block, 0)`)};
            var word_offset = local_id.x * ${t.blockSize/m};
            for (var i: u32 = 0; i < ${g}; i++) {
              let b_value = ${g===1?"b_data":"b_data[i]"};
              ${(()=>{let H=Math.floor(v/8),X="";for(let L=0;L<H;L++){let me=L*t.bits*4,qe=me+t.bits;X+=`
              ${q()}
              {${t.bits===2?`
                let half_word = b_value >> ${L*16}u;
                let byte_lo = half_word & 0xFFu;
                let byte_hi = (half_word >> 8u) & 0xFFu;
                let spread_word = (byte_lo & 0xFu) | ((byte_lo >> 4u) << 8u) | ((byte_hi & 0xFu) << 16u) | ((byte_hi >> 4u) << 24u);
                let b_value_lower = unpack4xU8(spread_word & 0x03030303u);
                let b_value_upper = unpack4xU8((spread_word >> 2u) & 0x03030303u);`:`
                let b_value_lower = unpack4xU8((b_value >> ${me}u) & 0x0F0F0F0Fu);
                let b_value_upper = unpack4xU8((b_value >> ${qe}u) & 0x0F0F0F0Fu);`}
                let b_quantized_values = mat2x4<${se}>(${Array.from({length:4},(Se,Ae)=>`${se}(b_value_lower[${Ae}]), ${se}(b_value_upper[${Ae}])`).join(", ")});
                let b_dequantized_values = (b_quantized_values - mat2x4<${se}>(${Array(8).fill("zero_point").join(",")})) * scale;
                inter_results[local_id.y][local_id.x] += ${Array.from({length:2},(Se,Ae)=>`${`dot(a_data${Ae}, b_dequantized_values[${Ae}])`}`).join(" + ")};
              }
              word_offset += ${8/m};`}return X})()}
            }
            workgroupBarrier();
          }

          if (local_idx < ${b}) {
            var output_value: ${V.type.value} = ${V.type.value}(0);
            for (var b = 0u; b < ${S}; b++) {
              output_value += inter_results[local_idx][b];
            }
            if (col + local_idx < uniforms.output_shape[2])
            {
              ${V.setByIndices(`${V.type.indices}(batch, row, col + local_idx)`,"output_value")}
            }
          }
        }`};return{name:"BlockwiseMatMulNBits32",shaderCache:{hint:`${t.blockSize};${m};${g};${S};${b}`,inputDependencies:Array(e.length).fill("rank")},getRunData:()=>({outputs:[{dims:y,dataType:h}],dispatchGroup:{x:E},programUniforms:A}),getShaderSource:M}},Eh=(e,t)=>{Ol(e.inputs,t),t.blockSize===32&&e.adapterInfo.isVendor("intel")&&e.adapterInfo.isArchitecture("gen-12lp")?e.compute(Bl(e.inputs,t)):e.compute(Rl(e.inputs,t))},zh=e=>fe(e)}),Nl,Ml,Dl,Ul,Pl,ql,Ll,Wl,Ch,C0=U(()=>{te(),ie(),ae(),Nl=e=>{if(!e||e.length<1)throw new Error("Too few inputs");if(e[0].dataType!==1&&e[0].dataType!==10)throw new Error("Input type must be float or float16.");if(e.length>=2){let t=e[0].dims.length*2===e[1].dims[0];if(e.length===4&&(t=e[3].dims[0]*2===e[1].dims[0]),!t)throw new Error("The pads should be a 1D tensor of shape [2 * input_rank] or [2 * num_axes].")}},Ml=(e,t,r)=>{let i="";for(let a=t-1;a>=0;--a)i+=`
            k = i32(${e.indicesGet("indices",a)}) - ${J("uniforms.pads",a,r)};
            if (k < 0) {
              break;
            }
            if (k >= i32(${J("uniforms.x_shape",a,t)})) {
              break;
            }
            offset += k * i32(${J("uniforms.x_strides",a,t)});
        `;return`
          value = ${e.type.value}(uniforms.constant_value);
          for (var i = 0; i < 1; i++) {
            var offset = 0;
            var k = 0;
            ${i}
            value = x[offset];
          }
      `},Dl=(e,t,r)=>{let i="";for(let a=t-1;a>=0;--a)i+=`
                k = i32(${e.indicesGet("indices",a)}) - ${J("uniforms.pads",a,r)};
                if (k < 0) {
                  k = -k;
                }
                {
                  let _2n_1 = 2 * (i32(${J("uniforms.x_shape",a,t)}) - 1);
                  k = k % _2n_1;
                  if(k >= i32(${J("uniforms.x_shape",a,t)})) {
                    k = _2n_1 - k;
                  }
                }
                offset += k * i32(${J("uniforms.x_strides",a,t)});
            `;return`
              var offset = 0;
              var k = 0;
              ${i}
              value = x[offset];
          `},Ul=(e,t,r)=>{let i="";for(let a=t-1;a>=0;--a)i+=`
                k = i32(${e.indicesGet("indices",a)}) - ${J("uniforms.pads",a,r)};
                if (k < 0) {
                  k = 0;
                }
                if (k >= i32(${J("uniforms.x_shape",a,t)})) {
                  k = i32(${J("uniforms.x_shape",a,t)}) - 1;
                }
                offset += k * i32(${J("uniforms.x_strides",a,t)});
            `;return`
              var offset = 0;
              var k = 0;
              ${i}
              value = x[offset];
          `},Pl=(e,t,r)=>{let i="";for(let a=t-1;a>=0;--a)i+=`
                k = i32(${e.indicesGet("indices",a)}) - ${J("uniforms.pads",a,r)};
                if (k < 0)  {
                  k += i32(${J("uniforms.x_shape",a,t)}]);
                }
                if (k >= i32(${J("uniforms.x_shape",a,t)})) {
                  k -= i32(${J("uniforms.x_shape",a,t)});
                }
                offset += k * i32(${J("uniforms.x_strides",a,t)});
            `;return`
              var offset = 0;
              var k = 0;
              ${i}
              value = x[offset];
          `},ql=(e,t,r)=>{switch(r.mode){case 0:return Ml(e,t,r.pads.length);case 1:return Dl(e,t,r.pads.length);case 2:return Ul(e,t,r.pads.length);case 3:return Pl(e,t,r.pads.length);default:throw new Error("Invalid mode")}},Ll=(e,t)=>{let r=R.padShape(e[0].dims.slice(),t.pads),i=e[0].dims,a=R.size(r),s=[{type:12,data:a},{type:6,data:t.pads}],n=e.length>=3&&e[2].data;t.mode===0&&s.push({type:n?e[2].dataType:1,data:t.value}),s.push(...ee(e[0].dims,r));let u=["rank"],l=p=>{let h=Q("output",e[0].dataType,r.length),m=N("x",e[0].dataType,i.length),g=m.type.value,y=ql(h,i.length,t),_=[{name:"output_size",type:"u32"},{name:"pads",type:"i32",length:t.pads.length}];return t.mode===0&&_.push({name:"constant_value",type:n?g:"f32"}),`
            ${p.registerUniforms(_).declareVariables(m,h)}
            ${p.mainStart()}
            ${p.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.output_size")}

            let indices = ${h.offsetToIndices("global_idx")};

            var value = ${g}(0);
            ${y}
            output[global_idx] = value;
        }`};return{name:"Pad",shaderCache:{hint:`${t.mode}${n}`,inputDependencies:u},getRunData:()=>({outputs:[{dims:r,dataType:e[0].dataType}],dispatchGroup:{x:Math.ceil(R.size(r)/64)},programUniforms:s}),getShaderSource:l}},Wl=(e,t)=>{if(e.length>1){let r=e[1].getBigInt64Array(),i=e.length>=3&&e[2].data?e[2].dataType===10?e[2].getUint16Array()[0]:e[2].getFloat32Array()[0]:0,a=e[0].dims.length,s=new Int32Array(2*a).fill(0);if(e.length>=4){let u=e[3].getBigInt64Array();for(let l=0;l<u.length;l++)s[Number(u[l])]=Number(r[l]),s[Number(u[l])+a]=Number(r[l+u.length])}else r.forEach((u,l)=>s[Number(l)]=Number(u));let n=[];return s.forEach(u=>n.push(u)),{mode:t.mode,value:i,pads:n}}else return t},Ch=(e,t)=>{Nl(e.inputs);let r=Wl(e.inputs,t);e.compute(Ll(e.inputs,r),{inputs:[0]})}}),rr,Yi,Ji,ea,ta,Vl,Gl,ra,ia,Ah,Oh,aa,Rh,Bh,na,Nh,Mh,Dh,Uh,A0=U(()=>{We(),te(),ie(),ae(),rr=e=>{if(we.webgpu.validateInputContent&&(!e||e.length!==1))throw new Error("Pool ops requires 1 input.")},Yi=(e,t,r)=>{let i=t.format==="NHWC",a=e.dims.slice();i&&a.splice(1,0,a.pop());let s=Object.hasOwnProperty.call(t,"dilations"),n=t.kernelShape.slice(),u=t.strides.slice(),l=s?t.dilations.slice():[],p=t.pads.slice();Gr.adjustPoolAttributes(r,a,n,u,l,p);let h=Gr.computePoolOutputShape(r,a,u,l,n,p,t.autoPad),m=Object.assign({},t);s?Object.assign(m,{kernelShape:n,strides:u,pads:p,dilations:l,cacheKey:t.cacheKey}):Object.assign(m,{kernelShape:n,strides:u,pads:p,cacheKey:t.cacheKey});let g=h.slice();return g.push(g.splice(1,1)[0]),[m,i?g:h]},Ji=(e,t)=>{let r=t.format==="NHWC",i=R.size(e),a=R.size(t.kernelShape),s=[{type:12,data:i},{type:12,data:a}],n=[{name:"outputSize",type:"u32"},{name:"kernelSize",type:"u32"}];if(t.kernelShape.length<=2){let u=t.kernelShape[t.kernelShape.length-1],l=t.strides[t.strides.length-1],p=t.pads[t.pads.length/2-1],h=t.pads[t.pads.length-1],m=!!(p+h);s.push({type:12,data:u},{type:12,data:l},{type:12,data:p},{type:12,data:h}),n.push({name:"kw",type:"u32"},{name:"sw",type:"u32"},{name:"pwStart",type:"u32"},{name:"pwEnd",type:"u32"});let g=!1;if(t.kernelShape.length===2){let y=t.kernelShape[t.kernelShape.length-2],_=t.strides[t.strides.length-2],b=t.pads[t.pads.length/2-2],S=t.pads[t.pads.length-2];g=!!(b+S),s.push({type:12,data:y},{type:12,data:_},{type:12,data:b},{type:12,data:S}),n.push({name:"kh",type:"u32"},{name:"sh",type:"u32"},{name:"phStart",type:"u32"},{name:"phEnd",type:"u32"})}return[s,n,!0,m,g]}else{if(r)throw new Error("Pooling with kernelShape.length > 2 is not supported for NHWC format.");let u=R.computeStrides(t.kernelShape);s.push({type:12,data:u},{type:12,data:t.pads},{type:12,data:t.strides}),n.push({name:"kernelStrides",type:"u32",length:u.length},{name:"pads",type:"u32",length:t.pads.length},{name:"strides",type:"u32",length:t.strides.length});let l=t.pads.reduce((p,h)=>p+h);return[s,n,!!l,!1,!1]}},ea=(e,t,r,i,a,s,n,u,l,p,h,m)=>{let g=a.format==="NHWC",y=t.type.value,_=Q("output",t.type.tensor,i);if(a.kernelShape.length<=2){let b="",S="",v="",w=r-(g?2:1);if(h?b=`
                for (var i: u32 = 0u; i < uniforms.kw; i++) {
                  xIndices[${w}] = indices[${w}] * uniforms.sw - uniforms.pwStart + i;
                  if (xIndices[${w}] < 0 || xIndices[${w}]
                      >= uniforms.x_shape[${w}]) {
                    pad++;
                    continue;
                  }
                  let x_val = x[${t.indicesToOffset("xIndices")}];
                  ${s}
                }`:b=`
                for (var i: u32 = 0u; i < uniforms.kw; i++) {
                  xIndices[${w}] = indices[${w}] * uniforms.sw - uniforms.pwStart + i;
                  let x_val = x[${t.indicesToOffset("xIndices")}];
                  ${s}
                }`,a.kernelShape.length===2){let I=r-(g?3:2);m?S=`
                for (var j: u32 = 0u; j < uniforms.kh; j++) {
                  xIndices[${I}] = indices[${I}] * uniforms.sh - uniforms.phStart + j;
                  if (xIndices[${I}] < 0 || xIndices[${I}] >= uniforms.x_shape[${I}]) {
                    pad += i32(uniforms.kw);
                    continue;
                  }
              `:S=`
                for (var j: u32 = 0u; j < uniforms.kh; j++) {
                  xIndices[${I}] = indices[${I}] * uniforms.sh - uniforms.phStart + j;
                `,v=`
              }
            `}return`
            ${e.registerUniforms(l).declareVariables(t,_)}

            ${e.mainStart()}
              ${e.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.outputSize")}

              let indices = ${_.offsetToIndices("global_idx")};
              var xIndices = ${_.offsetToIndices("global_idx")};

              var value = ${y}(${u});
              var pad = 0;
              ${S}
              ${b}
              ${v}
              ${n}

              output[global_idx] = value;
            }`}else{if(g)throw new Error("Pooling with kernelShape.length > 2 is not supported for NHWC format.");let b=a.kernelShape.length,S=a.pads.length,v="";return p?v=`
                if (xIndices[j] >= uniforms.x_shape[j]) {
                  pad++;
                  isPad = true;
                  break;
                }
              }
              if (!isPad) {
                let x_val = x[${t.indicesToOffset("xIndices")}];
                ${s}
              }`:v=`
              }
              let x_val = x[${t.indicesToOffset("xIndices")}];
              ${s}
            `,`
            ${e.registerUniforms(l).declareVariables(t,_)}

            ${e.mainStart()}
              ${e.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.outputSize")}
              let indices = ${_.offsetToIndices("global_idx")};
              var xIndices = ${_.offsetToIndices("global_idx")};

              var offsets: array<u32, ${b}>;

              var value = ${y}(${u});
              var pad = 0;
              var isPad = false;

              for (var i: u32 = 0u; i < uniforms.kernelSize; i++) {
                var offset = i;
                for (var j = 0u; j < ${b-1}u; j++) {
                  offsets[j] = offset / ${J("uniforms.kernelStrides","j",b)};
                  offset -= offsets[j] * ${J("uniforms.kernelStrides","j",b)};
                }
                offsets[${b-1}] = offset;

                isPad = false;
                for (var j = ${r-b}u; j < ${r}u; j++) {
                  xIndices[j] = indices[j] * ${J("uniforms.strides",`j - ${r-b}u`,b)}
                    + offsets[j - ${r-b}u] - ${J("uniforms.pads","j - 2u",S)};
                  ${v}
              }
              ${n}

              output[global_idx] = value;
            }`}},ta=e=>`${e.format};${e.ceilMode};${e.autoPad};${e.kernelShape.length}`,Vl=e=>`${ta(e)};${e.countIncludePad}`,Gl=e=>`${ta(e)};${e.storageOrder};${e.dilations}`,ra=e=>({format:e.format,autoPad:["NOTSET","VALID","SAME_UPPER","SAME_LOWER"][e.auto_pad],ceilMode:e.ceil_mode,kernelShape:e.kernel_shape,strides:e.strides,pads:e.pads}),ia=(e,t,r,i)=>{let[a,s]=Yi(t,i,r),n=N("x",t.dataType,t.dims.length),u=n.type.value,l="value += x_val;",p="";a.countIncludePad?p+=`value /= ${u}(uniforms.kernelSize);`:p+=`value /= ${u}(i32(uniforms.kernelSize) - pad);`;let[h,m,g,y,_]=Ji(s,a);h.push(...ee(t.dims,s));let b=["rank"];return{name:e,shaderCache:{hint:`${i.cacheKey};${g};${y};${_}`,inputDependencies:b},getRunData:()=>({outputs:[{dims:s,dataType:t.dataType}],dispatchGroup:{x:Math.ceil(R.size(s)/64)},programUniforms:h}),getShaderSource:S=>ea(S,n,t.dims.length,s.length,a,l,p,0,m,g,y,_)}},Ah=e=>{let t=e.count_include_pad!==0,r=ra(e);if(r.ceilMode!==0)throw new Error("using ceil() in shape computation is not yet supported for AveragePool");let i={countIncludePad:t,...r,cacheKey:""};return{...i,cacheKey:Vl(i)}},Oh=(e,t)=>{rr(e.inputs),e.compute(ia("AveragePool",e.inputs[0],!1,t))},aa={autoPad:"",ceilMode:0,countIncludePad:!1,kernelShape:[],strides:[],pads:[],storageOrder:0,dilations:[]},Rh=e=>{let t=e.format;return{format:t,...aa,cacheKey:t}},Bh=(e,t)=>{rr(e.inputs),e.compute(ia("GlobalAveragePool",e.inputs[0],!0,t))},na=(e,t,r,i)=>{let[a,s]=Yi(t,i,r),n=`
      value = max(x_val, value);
    `,u="",l=N("x",t.dataType,t.dims.length),p=["rank"],[h,m,g,y,_]=Ji(s,a);return h.push(...ee(t.dims,s)),{name:e,shaderCache:{hint:`${i.cacheKey};${g};${y};${_}`,inputDependencies:p},getRunData:()=>({outputs:[{dims:s,dataType:t.dataType}],dispatchGroup:{x:Math.ceil(R.size(s)/64)},programUniforms:h}),getShaderSource:b=>ea(b,l,t.dims.length,s.length,a,n,u,t.dataType===10?-65504:-1e5,m,g,y,_)}},Nh=(e,t)=>{rr(e.inputs),e.compute(na("MaxPool",e.inputs[0],!1,t))},Mh=e=>{let t=e.storage_order,r=e.dilations,i=ra(e);if(t!==0)throw new Error("column major storage order is not yet supported for MaxPool");if(i.ceilMode!==0)throw new Error("using ceil() in shape computation is not yet supported for MaxPool");let a={storageOrder:t,dilations:r,...i,cacheKey:""};return{...a,cacheKey:Gl(a)}},Dh=e=>{let t=e.format;return{format:t,...aa,cacheKey:t}},Uh=(e,t)=>{rr(e.inputs),e.compute(na("GlobalMaxPool",e.inputs[0],!0,t))}}),Hl,Fl,Ph,qh,O0=U(()=>{te(),ie(),xe(),ae(),Hl=(e,t)=>{if(e.length<2||e.length>3)throw new Error("DequantizeLinear requires 2 or 3 inputs.");if(e.length===3&&e[1].dims===e[2].dims)throw new Error("x-scale and x-zero-point must have the same shape.");if(e.length===3&&e[0].dataType!==e[2].dataType)throw new Error("x and x-zero-point must have the same data type.");if(e[1].dims.length!==0&&e[1].dims.length!==1&&e[1].dims.length!==e[0].dims.length)throw new Error("scale input must be a scalar, a 1D tensor, or have the same rank as the input tensor.");if(e.length>2){if(e[0].dataType!==e[2].dataType)throw new Error("x and x-zero-point must have the same data type.");if(e[1].dims.length!==e[2].dims.length)throw new Error("scale and zero-point inputs must have the same rank.");if(!e[1].dims.map((r,i)=>r===e[2].dims[i]).reduce((r,i)=>r&&i,!0))throw new Error("scale and zero-point inputs must have the same shape.")}if(t.blockSize>0){if(e[1].dims.length===0||e[1].dims.length===1&&e[1].dims[0]===1)throw new Error("blockSize must be set only for block quantization.");if(!e[1].dims.map((a,s)=>s===t.axis||a===e[0].dims[s]).reduce((a,s)=>a&&s,!0))throw new Error("For block qunatization, scale input shape to match the input shape except for the axis");if(e[1].dims.length!==e[0].dims.length)throw new Error("For block qunatization the scale input rank must be the same as the x rank.");let r=e[0].dims[t.axis],i=e[1].dims[t.axis];if(t.blockSize<Math.ceil(r/i)||t.blockSize>Math.ceil(r/(i-1)-1))throw new Error("blockSize must be with in the range [ceil(dI / Si), ceil(dI / (Si - 1) - 1)].")}},Fl=(e,t)=>{let r=R.normalizeAxis(t.axis,e[0].dims.length),i=e[0].dataType,a=i===3,s=e[0].dims,n=e[1].dataType,u=R.size(s),l=i===3||i===2,p=l?[Math.ceil(R.size(e[0].dims)/4)]:e[0].dims,h=e[1].dims,m=e.length>2?e[2]:void 0,g=m?l?[Math.ceil(R.size(m.dims)/4)]:m.dims:void 0,y=h.length===0||h.length===1&&h[0]===1,_=y===!1&&h.length===1,b=ve(u),S=y&&(!l||b===4),v=S?b:1,w=S&&!l?b:1,I=N("input",l?12:i,p.length,w),k=N("scale",n,h.length),E=m?N("zero_point",l?12:i,g.length):void 0,A=Q("output",n,s.length,v),C=[I,k];E&&C.push(E);let x=[p,h];m&&x.push(g);let D=[{type:12,data:u/v},{type:12,data:r},{type:12,data:t.blockSize},...ee(...x,s)],M=P=>{let K=[{name:"output_size",type:"u32"},{name:"axis",type:"u32"},{name:"block_size",type:"u32"}];return`
      ${P.registerUniforms(K).declareVariables(...C,A)}
      ${P.mainStart()}
          ${P.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.output_size")}
          let output_indices = ${A.offsetToIndices("global_idx")};

          // Set input x
          ${l?`
            let input = ${I.getByOffset("global_idx / 4")};
            let x_vec = ${a?"unpack4xI8(input)":"unpack4xU8(input)"};
            let x_value = ${v===1?"x_vec[global_idx % 4]":"x_vec"};`:`let x_value = ${I.getByOffset("global_idx")};`};

          // Set scale input
          ${y?`let scale_value= ${k.getByOffset("0")}`:_?`
            let scale_index = ${A.indicesGet("output_indices","uniforms.axis")};
            let scale_value= ${k.getByOffset("scale_index")};`:`
            var scale_indices: ${k.type.indices} = output_indices;
            let index = ${k.indicesGet("scale_indices","uniforms.axis")} / uniforms.block_size;
            ${k.indicesSet("scale_indices","uniforms.axis","index")};
            let scale_value= ${k.getByIndices("scale_indices")};`};

          // Set zero-point input
          ${E?y?l?`
                let zero_point_input = ${E.getByOffset("0")};
                let zero_point_vec =  ${a?"unpack4xI8(zero_point_input)":"unpack4xU8(zero_point_input)"};
                let zero_point_value= zero_point_vec[0]`:`let zero_point_value = ${E.getByOffset("0")}`:_?l?`
                let zero_point_index = ${A.indicesGet("output_indices","uniforms.axis")};
                let zero_point_input = ${E.getByOffset("zero_point_index / 4")};
                let zero_point_vec =  ${a?"unpack4xI8(zero_point_input)":"unpack4xU8(zero_point_input)"};
                let zero_point_value = zero_point_vec[zero_point_index % 4]`:`
                let zero_point_index = ${A.indicesGet("output_indices","uniforms.axis")};
                let zero_point_value = ${E.getByOffset("zero_point_index")};`:l?`
                let zero_point_offset = ${k.indicesToOffset("scale_indices")};
                let zero_point_input = ${E.getByOffset("zero_point_offset / 4")};
                let zero_point_vec = ${a?"unpack4xI8(zero_point_input)":"unpack4xU8(zero_point_input)"};
                let zero_point_value = zero_point_vec[zero_point_offset % 4];`:`let zero_point_value = ${E.getByIndices("scale_indices")};`:`let zero_point_value = ${l?a?"i32":"u32":I.type.value}(0);`};
      // Compute and write output
      ${A.setByOffset("global_idx",`${A.type.value}(x_value - zero_point_value) * scale_value`)};
      }`};return{name:"DequantizeLinear",shaderCache:{hint:t.cacheKey,inputDependencies:E?["rank","rank","rank"]:["rank","rank"]},getShaderSource:M,getRunData:()=>({outputs:[{dims:s,dataType:n}],dispatchGroup:{x:Math.ceil(u/v/64),y:1,z:1},programUniforms:D})}},Ph=(e,t)=>{Hl(e.inputs,t),e.compute(Fl(e.inputs,t))},qh=e=>fe({axis:e.axis,blockSize:e.blockSize})}),jl,Kl,Lh,R0=U(()=>{We(),te(),ae(),jl=(e,t,r)=>{let i=e===t,a=e<t&&r<0,s=e>t&&r>0;if(i||a||s)throw new Error("Range these inputs' contents are invalid.")},Kl=(e,t,r,i)=>{let a=Math.abs(Math.ceil((t-e)/r)),s=[a],n=a,u=[{type:12,data:n},{type:i,data:e},{type:i,data:r},...ee(s)],l=p=>{let h=Q("output",i,s.length),m=h.type.value,g=[{name:"outputSize",type:"u32"},{name:"start",type:m},{name:"delta",type:m}];return`
        ${p.registerUniforms(g).declareVariables(h)}
        ${p.mainStart()}
        ${p.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.outputSize")}
        output[global_idx] = uniforms.start + ${m}(global_idx) * uniforms.delta;
      }`};return{name:"Range",shaderCache:{hint:`${i}`},getShaderSource:l,getRunData:()=>({outputs:[{dims:s,dataType:i}],dispatchGroup:{x:Math.ceil(n/64)},programUniforms:u})}},Lh=e=>{let t=0,r=0,i=0;e.inputs[0].dataType===6?(t=e.inputs[0].getInt32Array()[0],r=e.inputs[1].getInt32Array()[0],i=e.inputs[2].getInt32Array()[0]):e.inputs[0].dataType===1&&(t=e.inputs[0].getFloat32Array()[0],r=e.inputs[1].getFloat32Array()[0],i=e.inputs[2].getFloat32Array()[0]),we.webgpu.validateInputContent&&jl(t,r,i),e.compute(Kl(t,r,i,e.inputs[0].dataType),{inputs:[]})}}),Zl,Xl,Wh,Vh,B0=U(()=>{te(),ie(),xe(),ae(),Zl=(e,t,r,i)=>{if(e!=="none"&&i!=="i32"&&i!=="u32"&&i!=="f32")throw new Error(`Input ${i} is not supported with reduction ${e}.`);let a=`{
                var oldValue = 0;
                loop {
                  let newValueF32 =`,s=`;
                  let newValue = bitcast<i32>(newValueF32);
                  let res = atomicCompareExchangeWeak(&${t}, oldValue, newValue);
                  if res.exchanged {
                    break;
                  }
                  oldValue = res.old_value;
                }
              }`;switch(e){case"none":return`${t}=${r};`;case"add":return i==="i32"||i==="u32"?`atomicAdd(&${t}, bitcast<${i}>(${r}));`:`
              ${a}bitcast<${i}>(oldValue) + (${r})${s}`;case"max":return i==="i32"||i==="u32"?`atomicMax(&${t}, bitcast<${i}>(${r}));`:`
                ${a}max(bitcast<f32>(oldValue), (${r}))${s}`;case"min":return i==="i32"||i==="u32"?`atomicMin(&${t}, bitcast<${i}>(${r}));`:`${a}min(bitcast<${i}>(oldValue), (${r}))${s}`;case"mul":return`${a}(bitcast<${i}>(oldValue) * (${r}))${s}`;default:throw new Error(`Reduction ${e} is not supported.`)}},Xl=(e,t)=>{let r=e[0].dims,i=e[1].dims,a=r,s=1,n=Math.ceil(R.sizeToDimension(i,i.length-1)/s),u=i[i.length-1],l=R.sizeFromDimension(r,u),p=[{type:12,data:n},{type:12,data:u},{type:12,data:l},...ee(e[1].dims,e[2].dims,a)],h=m=>{let g=N("indices",e[1].dataType,e[1].dims.length),y=N("updates",e[2].dataType,e[2].dims.length,s),_=t.reduction!=="none"&&t.reduction!==""?yp("output",e[0].dataType,a.length):Q("output",e[0].dataType,a.length,s);return`
      ${m.registerUniform("output_size","u32").registerUniform("last_index_dimension","u32").registerUniform("num_updates_elements","u32").declareVariables(g,y,_)}
      ${m.mainStart()}
        ${m.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.output_size")}
  var data_offset = 0u;
  let indices_start = uniforms.last_index_dimension * global_idx;
  let indices_end = indices_start + uniforms.last_index_dimension;
  for (var i = indices_start; i < indices_end; i++) {
    var index = i32(indices[i].x);
    ${e[0].dims.length===1?`
    let element_count_dim = uniforms.output_strides;
    let dim_value = uniforms.output_shape;`:`
    let element_count_dim = uniforms.output_strides[i - indices_start];
    let dim_value = uniforms.output_shape[i - indices_start];`}
    if (index >= 0) {
      if (index >= i32(dim_value)) {
        index = i32(dim_value - 1);
      }
    } else {
      if (index < -i32(dim_value)) {
        index = 0;
      } else {
        index += i32(dim_value);
      }
    }
    data_offset += u32((u32(index) * element_count_dim));
  }

  for (var i = 0u; i < uniforms.num_updates_elements; i++) {
    let value = updates[uniforms.num_updates_elements * global_idx + i];
    ${Zl(t.reduction,"output[data_offset + i]","value",_.type.value)}
  }

      }`};return{name:"ScatterND",shaderCache:{hint:`${t.cacheKey}_${t.reduction}`,inputDependencies:["rank","rank"]},getRunData:()=>({outputs:[{dims:a,dataType:e[0].dataType}],dispatchGroup:{x:Math.ceil(n/64)},programUniforms:p}),getShaderSource:h}},Wh=e=>fe({reduction:e.reduction}),Vh=(e,t)=>{e.compute(Xl(e.inputs,t),{inputs:[e.inputs[1],e.inputs[2]],outputs:[]})}}),Ql,Yl,Jl,sa,ed,td,rd,id,ad,nd,sd,od,oa,ud,ld,dd,pd,cd,Gh,Hh,N0=U(()=>{te(),ie(),xe(),ae(),Ql=(e,t)=>{if(e.every(r=>r>0||(()=>{throw new Error("Resize requires scales input values to be positive")})),e.length>0){if(t.mode==="linear"){if(!(e.length===2||e.length===3||e.length===4&&e[0]===1&&e[1]===1||e.length===4&&e[0]===1&&e[3]===1||e.length===5&&e[0]===1&&e[1]===1))throw new Error(`For linear mode, Resize requires scales to be 2D, 3D, 4D with either two outermost or one innermost and
            one outermost scale values equal to 1, or 5D with two outermost scale values equal to 1`)}else if(t.mode==="cubic"&&!(e.length===2||e.length===4&&e[0]===1&&e[1]===1||e.length===4&&e[0]===1&&e[3]===1))throw new Error("Resize requires scales input size to be 2 or 4 for cubic mode")}},Yl=(e,t,r)=>{t.every(a=>a>=0&&a<r||(()=>{throw new Error("Resize requires axes input values to be positive and less than rank")}));let i=new Array(r).fill(1);return t.forEach((a,s)=>i[a]=e[s]),i},Jl=(e,t,r,i,a,s)=>{let[n,u,l]=r>10?[1,2,3]:[-1,e.length>1?1:-1,-1],p=e[0].dims.length;if(n>0&&e.length>n&&e[n].dims.length>0)e[n].getFloat32Array().forEach(h=>s.push(h));else if(t.coordinateTransformMode==="tf_crop_and_resize")throw new Error("Resize requires RoI input to be specified when coordinateTransformMode is tfCropAndResize");if(u>0&&e.length>u&&e[u].dims.length===1&&e[u].dims[0]>0){if(e[u].getFloat32Array().forEach(h=>i.push(h)),i.length!==0&&i.length!==p&&r>=18&&i.length!==t.axes.length)throw new Error("Resize requires scales input size to be same as input rank or axes size for opset 18 and up");Ql(i,t),t.axes.length>0&&Yl(i,t.axes,p).forEach((h,m)=>i[m]=h)}if(l>0&&e.length>l&&e[l].dims.length===1&&e[l].dims[0]>0&&(e[l].getBigInt64Array().forEach(h=>a.push(Number(h))),a.length!==0&&a.length!==p&&r>=18&&a.length!==t.axes.length))throw new Error("Resize requires sizes input size to be same as input rank or axes size for opset 18 and up");if(t.axes.length>0){if(i.length!==0&&i.length!==t.axes.length)throw new Error('Resize requires "scales" input size to be of axes rank when axes attributes is specified');if(a.length!==0&&a.length!==t.axes.length)throw new Error('Resize requires "sizes" input size to be of rank axes rank when axes attributes is specified')}if(typeof i<"u"&&typeof a<"u"&&i.length>0&&a.length>p)throw new Error("Resize requires only of scales or sizes to be specified")},sa=(e,t,r,i)=>`
  // The whole part and the fractional part are calculated separately due to inaccuracy of floating
  // point division. As an example, f32(21) / f32(7) may evaluate to 2.99... instead of 3, causing an
  // offset-by-one error later in floor().
  let big = (${e}) * (${t});
  let whole = ${i}(big / (${r}));
  let fract = ${i}(big % (${r})) / ${i}(${r});
  return whole + fract;
`,ed=(e,t)=>`fn getOriginalCoordinateFromResizedCoordinate(xResized: u32, xScale: f32, lengthResized: u32,
     lengthOriginal: u32, roiStart: f32, roiEnd: f32) -> ${t} { `+(()=>{switch(e){case"asymmetric":return`
          if (xScale < 1.0 || floor(xScale) != xScale) {
            return ${t}(xResized) / ${t}(xScale);
          } else {
            ${sa("xResized","lengthOriginal","lengthResized",t)}
          }
        `;case"pytorch_half_pixel":return`if (lengthResized > 1) {
                    return (${t}(xResized) + 0.5) / ${t}(xScale) - 0.5;
                  } else {
                    return 0.0;
                  }`;case"tf_half_pixel_for_nn":return`return (${t}(xResized) + 0.5) / ${t}(xScale);`;case"align_corners":return`if (lengthResized == 1) {
                    return 0.0;
                  } else {
                    ${sa("xResized","lengthOriginal - 1","lengthResized - 1",t)}
                  }`;case"tf_crop_and_resize":return`if (lengthResized > 1) {
                    return ${t}(roiStart) * ${t}(lengthOriginal - 1) +
                        (${t}(xResized) * ${t}(roiEnd - roiStart) * ${t}(lengthOriginal - 1)) /
                        ${t}(lengthResized - 1);
                  } else {
                    return 0.5 * ${t}(roiStart + roiEnd) * ${t}(lengthOriginal - 1);
                  }`;case"half_pixel_symmetric":return`const outputWidth = ${t}xScale * ${t}(lengthResized);
                  const adjustment = ${t}(lengthResized) / outputWidth;
                  const center = ${t}(lengthOriginal) / 2;
                  const offset = center * (1 - adjustment);
                  return offset + ((${t}(xResized) + 0.5) / ${t}(xScale)) - 0.5;`;case"half_pixel":return`return ((${t}(xResized) + 0.5) / ${t}(xScale)) - 0.5;`;default:throw new Error(`Coordinate transform mode ${e} is not supported`)}})()+"}",td=(e,t,r)=>`fn getNearestPixelFromOriginal(xOriginal: ${r}, isDownSample: bool) -> ${r} {`+(()=>{switch(e){case"round_prefer_ceil":return"if (fract(xOriginal) == 0.5) {             return ceil(xOriginal);           } else {             return round(xOriginal);           }";case"floor":return"return floor(xOriginal);";case"ceil":return"return ceil(xOriginal);";case"round_prefer_floor":return"if (fract(xOriginal) == 0.5) {                     return floor(xOriginal);                   } else {                     return round(xOriginal);                   }";default:if(t<11)return"if (isDownSample)                     {                       return ceil(xOriginal);                     } else {                       return xOriginal;                     }";throw new Error(`Nearest mode ${e} is not supported`)}})()+"}",rd=(e,t,r)=>{let i=new Array(r).fill(0).concat(new Array(r).fill(1)),a=e.length===0?i:e.slice();return t.length>0?(t.forEach((s,n)=>{i[s]=a[n],i[n+r]=a[t.length+n]}),i):a},id=(e,t,r,i)=>{let a=[];if(r.length>0)if(i.length>0){if(e.forEach(s=>a.push(s)),Math.max(...i)>e.length)throw new Error("axes is out of bound");i.forEach((s,n)=>a[s]=r[n])}else r.forEach(s=>a.push(s));else{if(t.length===0)throw new Error("Resize requires either scales or sizes.");a=e.map((s,n)=>Math.round(s*t[n]))}return a},ad=(e,t,r)=>{let i=(()=>{switch(r.keepAspectRatioPolicy){case"not_larger":return r.axes.length>0?Math.min(...r.axes.map(s=>t[s]),Number.MAX_VALUE):Math.min(...t,Number.MAX_VALUE);case"not_smaller":return r.axes.length>0?Math.max(...r.axes.map(s=>t[s]),Number.MIN_VALUE):Math.max(...t,Number.MIN_VALUE);default:throw new Error(`Keep aspect ratio policy ${r.keepAspectRatioPolicy} is not supported`)}})();t.fill(1,0,t.length);let a=e.slice();return r.axes.length>0?(r.axes.forEach(s=>t[s]=i),r.axes.forEach(s=>a[s]=Math.round(e[s]*t[s]))):(t.fill(i,0,t.length),a.forEach((s,n)=>a[n]=Math.round(s*t[n]))),a},nd=(e,t,r,i,a)=>`
    fn calculateOriginalIndicesFromOutputIndices(output_indices: ${e.type.indices}) -> array<${e.type.value}, ${r.length}> {
      var original_indices: array<${e.type.value}, ${r.length}>;
      for (var i:u32 = 0; i < ${r.length}; i++) {
        var output_index = ${e.indicesGet("output_indices","i")};
        var scale = ${J("uniforms.scales","i",i)};
        var roi_low = ${J("uniforms.roi","i",a)};
        var roi_hi = ${J("uniforms.roi",`i + ${t.length}`,a)};
        if (scale == 1.0) {
          original_indices[i] = ${e.type.value}(output_index);
        } else {
          var input_shape_i = ${J("uniforms.input_shape","i",t.length)};
          var output_shape_i = ${J("uniforms.output_shape","i",r.length)};
          original_indices[i] = getOriginalCoordinateFromResizedCoordinate(output_index, scale, output_shape_i,
                                                                           input_shape_i, roi_low, roi_hi);
        }
      }
      return original_indices;
    }`,sd=(e,t,r,i,a,s,n)=>`
    fn calculateInputIndicesFromOutputIndices(output_indices: ${t.type.indices}) -> ${e.type.indices} {
      var input_indices: ${e.type.indices};
      for (var i:u32 = 0; i < ${i.length}; i++) {
        var output_index = ${t.indicesGet("output_indices","i")};
        var input_index: u32;
        var scale = ${J("uniforms.scales","i",a)};
        if (scale == 1.0) {
          input_index = output_index;
        } else {
          var roi_low = ${J("uniforms.roi","i",s)};
          var roi_hi = ${J("uniforms.roi",`i + ${r.length}`,s)};
          var input_shape_i = ${J("uniforms.input_shape","i",r.length)};
          var output_shape_i = ${J("uniforms.output_shape","i",i.length)};
          var original_idx = getOriginalCoordinateFromResizedCoordinate(output_index, scale, output_shape_i,
                                                                        input_shape_i, roi_low, roi_hi);
          if (!${n} || (original_idx >= 0 && original_idx < ${t.type.value}(input_shape_i))) {
            if (original_idx < 0) {
              input_index = 0;
            } else if (original_idx > ${t.type.value}(input_shape_i - 1)) {
              input_index = input_shape_i - 1;
            } else {
              input_index = u32(getNearestPixelFromOriginal(original_idx, scale < 1));
            }
          } else {
            input_index = u32(original_idx);
          }
        }
        ${e.indicesSet("input_indices","i","input_index")}
      }
      return input_indices;
    }`,od=(e,t)=>`
    fn checkInputIndices(input_indices: ${e.type.indices}) -> bool {
      for (var i:u32 = 0; i < ${t.length}; i++) {
        var input_index = ${e.indicesGet("input_indices","i")};
        if (input_index < 0 || input_index >= ${J("uniforms.input_shape","i",t.length)}) {
          return false;
        }
      }
      return true;
    }`,oa=(e,t,r,i)=>e.rank>i?`
    ${e.indicesSet("input_indices",t,"channel")};
    ${e.indicesSet("input_indices",r,"batch")};
`:"",ud=(e,t,r,i,a)=>{let[s,n,u,l]=r.length===2?[-1,0,1,-1]:[0,2,3,1],p=e.type.value;return`
    fn getInputValue(batch: u32, channel: u32, row: u32, col: u32) -> ${p} {
      var input_indices: ${e.type.indices};
      ${e.indicesSet("input_indices",n,`max(0, min(row, ${r[n]} - 1))`)};
      ${e.indicesSet("input_indices",u,`max(0, min(col, ${r[u]} - 1))`)};
      ${oa(e,l,s,2)}
      return ${e.getByIndices("input_indices")};
    }

    fn bilinearInterpolation(output_indices: ${t.type.indices}) -> ${p} {
      var originalIndices = calculateOriginalIndicesFromOutputIndices(output_indices);
      var row:${p} = originalIndices[${n}];
      var col:${p} = originalIndices[${u}];
      ${i?`if (row < 0 || row > (${r[n]} - 1) || col < 0 || col > (${r[u]} - 1)) {
        return ${a};
      }`:""};
      row = max(0, min(row, ${r[n]} - 1));
      col = max(0, min(col, ${r[u]} - 1));
      var row1: u32 = u32(row);
      var col1: u32 = u32(col);
      var row2: u32 = u32(row + 1);
      var col2: u32 = u32(col + 1);
      var channel: u32 = ${r.length>2?`u32(originalIndices[${l}])`:"0"};
      var batch: u32 =  ${r.length>2?`u32(originalIndices[${s}])`:"0"};
      var x11: ${p} = getInputValue(batch, channel, row1, col1);
      var x12: ${p} = getInputValue(batch, channel, row1, col2);
      var x21: ${p} = getInputValue(batch, channel, row2, col1);
      var x22: ${p} = getInputValue(batch, channel, row2, col2);
      var dx1: ${p} = abs(row - ${p}(row1));
      var dx2: ${p} = abs(${p}(row2) - row);
      var dy1: ${p} = abs(col - ${p}(col1));
      var dy2: ${p} = abs(${p}(col2) - col);
      if (row1 == row2) {
        dx1 = 0.5;
        dx2 = 0.5;
      }
      if (col1 == col2) {
        dy1 = 0.5;
        dy2 = 0.5;
      }
      return (x11 * dx2 * dy2 + x12 * dx2 * dy1 + x21 * dx1 * dy2 + x22 * dx1 * dy1);
    }`},ld=(e,t,r,i,a,s,n,u,l,p)=>{let h=r.length===2,[m,g]=h?[0,1]:[2,3],y=e.type.value,_=b=>{let S=b===m?"row":"col";return`
      fn ${S}CubicInterpolation(input_indices: ${e.type.indices}, output_indices: ${t.type.indices}) -> ${y} {
        var output_index = ${t.indicesGet("output_indices",b)};
        var originalIdx: ${y} = getOriginalCoordinateFromResizedCoordinate(output_index, ${a[b]},
        ${i[b]}, ${r[b]}, ${s[b]}, ${s[b]} + ${r.length});
        var fractOriginalIdx: ${y} = originalIdx - floor(originalIdx);
        var coefs = getCubicInterpolationCoefs(fractOriginalIdx);

        if (${u} && (originalIdx < 0 || originalIdx > (${r[b]} - 1))) {
          return ${l};
        }
        var data: array<${y}, 4> = array<${y}, 4>(0.0, 0.0, 0.0, 0.0);
        for (var i: i32 = -1; i < 3; i++) {
          var ${S}: ${y} = originalIdx + ${y}(i);
          if (${S} < 0 || ${S} >= ${r[b]}) {
            ${p?`coefs[i + 1] = 0.0;
                        continue;`:u?`return ${l};`:`${S} = max(0, min(${S}, ${r[b]} - 1));`};
          }
        var input_indices_copy: ${e.type.indices} = input_indices;
          ${e.indicesSet("input_indices_copy",b,`u32(${S})`)};
          data[i + 1] = ${b===m?e.getByIndices("input_indices_copy"):"rowCubicInterpolation(input_indices_copy, output_indices)"};
        }
        return cubicInterpolation1D(data, coefs);
      }`};return`
    ${_(m)};
    ${_(g)};
  fn getCubicInterpolationCoefs(s: ${y}) -> array<${y}, 4> {
    var absS = abs(s);
    var coeffs: array<${y}, 4> = array<${y}, 4>(0.0, 0.0, 0.0, 0.0);
    var oneMinusAbsS: ${y} = 1.0 - absS;
    var twoMinusAbsS: ${y} = 2.0 - absS;
    var onePlusAbsS: ${y} = 1.0 + absS;
    coeffs[0] = ((${n} * onePlusAbsS - 5 * ${n}) * onePlusAbsS + 8 * ${n}) * onePlusAbsS - 4 * ${n};
    coeffs[1] = ((${n} + 2) * absS - (${n} + 3)) * absS * absS + 1;
    coeffs[2] = ((${n} + 2) * oneMinusAbsS - (${n} + 3)) * oneMinusAbsS * oneMinusAbsS + 1;
    coeffs[3] = ((${n} * twoMinusAbsS - 5 * ${n}) * twoMinusAbsS + 8 * ${n}) * twoMinusAbsS - 4 * ${n};
    return coeffs;
  }

  fn cubicInterpolation1D(x: array<${y}, 4>, coefs: array<${y}, 4>) -> ${y} {
    var coefsSum: ${y} = coefs[0] + coefs[1] + coefs[2] + coefs[3];
    return (x[0] * coefs[0] + x[1] * coefs[1]+ x[2] * coefs[2]+ x[3] * coefs[3]) / coefsSum;
  }

  fn bicubicInterpolation(output_indices: ${t.type.indices}) -> ${y} {
    var input_indices: ${e.type.indices} = output_indices;
    return colCubicInterpolation(input_indices, output_indices);
  }
    `},dd=(e,t,r,i,a)=>{let[s,n,u,l,p]=r.length===3?[-1,0,1,2,-1]:[0,2,3,4,1],h=e.type.value;return`
    fn getInputValue(batch: u32, channel: u32, depth:u32, height: u32, width: u32) -> ${h} {
      var input_indices: ${e.type.indices};
      ${e.indicesSet("input_indices",n,`max(0, min(depth, ${r[n]} - 1))`)};
      ${e.indicesSet("input_indices",u,`max(0, min(height, ${r[u]} - 1))`)};
      ${e.indicesSet("input_indices",l,`max(0, min(width, ${r[l]} - 1))`)};
      ${oa(e,p,s,3)}
      return ${e.getByIndices("input_indices")};
    }

    fn trilinearInterpolation(output_indices: ${t.type.indices}) -> ${h} {
      var originalIndices = calculateOriginalIndicesFromOutputIndices(output_indices);
      var depth:${h} = originalIndices[${n}];
      var height:${h} = originalIndices[${u}];
      var width:${h} = originalIndices[${l}];
      ${i?`if (depth < 0 || depth > (${r[n]} - 1) || height < 0 || height > (${r[u]} - 1) || width < 0 || (width > ${r[l]} - 1)) {
      return ${a};
        }`:""};

    depth = max(0, min(depth, ${r[n]} - 1));
      height = max(0, min(height, ${r[u]} - 1));
      width = max(0, min(width, ${r[l]} - 1));
      var depth1: u32 = u32(depth);
      var height1: u32 = u32(height);
      var width1: u32 = u32(width);
      var depth2: u32 = u32(depth + 1);
      var height2: u32 = u32(height + 1);
      var width2: u32 = u32(width + 1);
      var channel: u32 = ${r.length>3?`u32(originalIndices[${p}])`:"0"};
      var batch: u32 =  ${r.length>3?`u32(originalIndices[${s}])`:"0"};

      var x111: ${h} = getInputValue(batch, channel, depth1, height1, width1);
      var x112: ${h} = getInputValue(batch, channel, depth1, height1, width2);
      var x121: ${h} = getInputValue(batch, channel, depth1, height2, width1);
      var x122: ${h} = getInputValue(batch, channel, depth1, height2, width2);
      var x211: ${h} = getInputValue(batch, channel, depth2, height1, width1);
      var x212: ${h} = getInputValue(batch, channel, depth2, height1, width2);
      var x221: ${h} = getInputValue(batch, channel, depth2, height2, width1);
      var x222: ${h} = getInputValue(batch, channel, depth2, height2, width2);
      var dx1: ${h} = abs(depth - ${h}(depth1));
      var dx2: ${h} = abs(${h}(depth2) - depth);
      var dy1: ${h} = abs(height - ${h}(height1));
      var dy2: ${h} = abs(${h}(height2) - height);
      var dz1: ${h} = abs(width - ${h}(width1));
      var dz2: ${h} = abs(${h}(width2) - width);
      if (depth1 == depth2) {
        dx1 = 0.5;
        dx2 = 0.5;
      }
      if (height1 == height2) {
        dy1 = 0.5;
        dy2 = 0.5;
      }
      if (width1 == width2) {
        dz1 = 0.5;
        dz2 = 0.5;
      }
      return (x111 * dx2 * dy2 * dz2 + x112 * dx2 * dy2 * dz1 + x121 * dx2 * dy1 *dz2 + x122 * dx2 * dy1 * dz1 +
              x211 * dx1 * dy2 * dz2 + x212 * dx1 * dy2 * dz1 + x221 * dx1 * dy1 *dz2 + x222 * dx1 * dy1 * dz1);
    }`},pd=(e,t,r,i,a,s)=>{let n=e.dims,u=rd(s,t.axes,n.length),l=id(n,i,a,t.axes),p=i.slice();i.length===0&&(p=n.map((w,I)=>w===0?1:l[I]/w),t.keepAspectRatioPolicy!=="stretch"&&(l=ad(n,p,t)));let h=Q("output",e.dataType,l.length),m=N("input",e.dataType,n.length),g=R.size(l),y=n.length===l.length&&n.every((w,I)=>w===l[I]),_=t.coordinateTransformMode==="tf_crop_and_resize",b=t.extrapolationValue,S=m.type.value,v=w=>`
      ${y?"":`
      ${ed(t.coordinateTransformMode,S)};
      ${(()=>{switch(t.mode){case"nearest":return`
              ${od(m,n)};
              ${td(t.nearestMode,r,S)};
              ${sd(m,h,n,l,p.length,u.length,_)};
              `;case"linear":return`
              ${nd(h,n,l,p.length,u.length)};
              ${(()=>{if(n.length===2||n.length===4)return`${ud(m,h,n,_,b)}`;if(n.length===3||n.length===5)return`${dd(m,h,n,_,b)}`;throw Error("Linear mode only supports input dims 2, 3, 4 and 5 are supported in linear mode.")})()};
            `;case"cubic":return`
            ${(()=>{if(n.length===2||n.length===4)return`${ld(m,h,n,l,p,u,t.cubicCoeffA,_,t.extrapolationValue,t.excludeOutside)}`;throw Error("Cubic mode only supports input dims 2 and 4 are supported in linear mode.")})()};
            `;default:throw Error("Invalid resize mode")}})()};
      `}
      ${w.registerUniform("output_size","u32").registerUniform("scales","f32",p.length).registerUniform("roi","f32",u.length).declareVariables(m,h)}
      ${w.mainStart()}
        ${w.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.output_size")}
        ${y?"output[global_idx] = input[global_idx];":`
        let output_indices = ${h.offsetToIndices("global_idx")};
        var input_indices: ${m.type.indices};
        ${(()=>{switch(t.mode){case"nearest":return`input_indices = calculateInputIndicesFromOutputIndices(output_indices);
                if (checkInputIndices(input_indices)) {
                  output[global_idx] = ${m.getByIndices("input_indices")};
                } else {
                  output[global_idx] = ${t.extrapolationValue};
                }`;case"linear":return`output[global_idx] = ${n.length===2||n.length===4?"bilinearInterpolation":"trilinearInterpolation"}(output_indices);`;case"cubic":return"output[global_idx] = bicubicInterpolation(output_indices);";default:throw Error(`Unsupported resize mode: ${t.mode}`)}})()};
`}
      }`;return{name:"Resize",shaderCache:{hint:`${t.cacheKey}|${r}|${p.length>0?t.mode==="cubic"?p:p.length:""}|${a.length>0?a:""}|${u.length>0?u:""}|${y}|${t.mode==="nearest"?n.length:n}`,inputDependencies:["rank"]},getShaderSource:v,getRunData:()=>({outputs:[{dims:l,dataType:e.dataType}],dispatchGroup:{x:Math.ceil(g/64)},programUniforms:[{type:12,data:g},{type:1,data:p},{type:1,data:u},...ee(n,l)]})}},cd=e=>{let t=e.customDataBuffer;return new Uint32Array(t.buffer,t.byteOffset,1)[0]},Gh=(e,t)=>{let r=[],i=[],a=[],s=cd(e);if(t.antialias!==0)throw Error("Only default value (0) for Antialias attribute is supported");Jl(e.inputs,t,s,r,i,a),e.compute(pd(e.inputs[0],t,s,r,i,a),{inputs:[0]})},Hh=e=>{let t=e.antialias,r=e.axes,i=e.coordinateTransformMode,a=e.cubicCoeffA,s=e.excludeOutside!==0,n=e.extrapolationValue,u=e.keepAspectRatioPolicy,l=e.mode,p=e.nearestMode===""?"simple":e.nearestMode;return fe({antialias:t,axes:r,coordinateTransformMode:i,cubicCoeffA:a,excludeOutside:s,extrapolationValue:n,keepAspectRatioPolicy:u,mode:l,nearestMode:p})}}),hd,fd,Fh,M0=U(()=>{te(),ie(),ae(),hd=e=>{if(!e||e.length<3)throw new Error("layerNorm requires at least 3 inputs.");let t=e[0],r=e[1],i=e[2];if(t.dataType!==r.dataType||t.dataType!==i.dataType)throw new Error("All inputs must have the same data type");if(t.dims.length!==3&&t.dims.length!==2)throw new Error("Input must be 2D or 3D");if(r.dims.length!==3&&r.dims.length!==2)throw new Error("Skip must be 2D or 3D");let a=t.dims[t.dims.length-1],s=t.dims[t.dims.length-2];if(r.dims[r.dims.length-1]!==a)throw new Error("Skip must have the same hidden size as input");if(r.dims[r.dims.length-2]!==s)throw new Error("Skip must have the same sequence length as input");if(i.dims.length!==1)throw new Error("Gamma must be 1D");if(i.dims[i.dims.length-1]!==a)throw new Error("Gamma must have the same hidden size as input");if(e.length>3){let n=e[3];if(n.dims.length!==1)throw new Error("Beta must be 1D");if(n.dims[n.dims.length-1]!==a)throw new Error("Beta must have the same hidden size as input")}if(e.length>4){let n=e[4];if(n.dims.length!==1)throw new Error("Bias must be 1D");if(n.dims[n.dims.length-1]!==a)throw new Error("Bias must have the same hidden size as input")}},fd=(e,t,r,i)=>{let a=t.simplified,s=e[0].dims,n=R.size(s),u=s,l=n,p=s.slice(-1)[0],h=i?s.slice(0,-1).concat(1):[],m=!a&&e.length>3,g=e.length>4,y=i&&r>1,_=i&&r>2,b=r>3,S=64,v=ve(p),w=[{type:12,data:l},{type:12,data:v},{type:12,data:p},{type:1,data:t.epsilon}],I=E=>{let A=[{name:"output_size",type:"u32"},{name:"components",type:"u32"},{name:"hidden_size",type:"u32"},{name:"epsilon",type:"f32"}],C=[N("x",e[0].dataType,e[0].dims,v),N("skip",e[1].dataType,e[1].dims,v),N("gamma",e[2].dataType,e[2].dims,v)];m&&C.push(N("beta",e[3].dataType,e[3].dims,v)),g&&C.push(N("bias",e[4].dataType,e[4].dims,v)),C.push(Q("output",e[0].dataType,u,v)),y&&C.push(Q("mean_output",1,h)),_&&C.push(Q("inv_std_output",1,h)),b&&C.push(Q("input_skip_bias_sum",e[0].dataType,u,v));let x=Te(e[0].dataType),D=Te(1,v);return`

      ${E.registerUniforms(A).declareVariables(...C)}
      var<workgroup> sum_shared : array<${D}, ${S}>;
      var<workgroup> sum_squared_shared : array<${D}, ${S}>;

      ${E.mainStart([S,1,1])}
        let ix = local_id.x;
        let iy = global_id.x / ${S};

        let hidden_size_vectorized: u32 = uniforms.hidden_size / uniforms.components;
        var stride = hidden_size_vectorized / ${S};
        let offset = ix * stride + iy * hidden_size_vectorized;
        let offset1d = stride * ix;
        if (ix == ${S-1}) {
          stride = hidden_size_vectorized - stride * ix;
        }
        for (var i: u32 = 0; i < stride; i++) {
          let skip_value = skip[offset + i];
          let bias_value = ${g?"bias[offset1d + i]":x+"(0.0)"};
          let input_value = x[offset + i];
          let value = input_value + skip_value + bias_value;
          ${b?"input_skip_bias_sum[offset + i] = value;":""}
          output[offset + i] = value;
          let f32_value = ${Lt(x,v,"value")};
          sum_shared[ix] += f32_value;
          sum_squared_shared[ix] += f32_value * f32_value;
        }
        workgroupBarrier();

        var reduce_size : u32 = ${S};
        for (var curr_size = reduce_size >> 1;  curr_size > 0; curr_size = reduce_size >> 1) {
          reduce_size = curr_size + (reduce_size & 1);
          if (ix < curr_size) {
            sum_shared[ix] += sum_shared[ix + reduce_size];
            sum_squared_shared[ix] += sum_squared_shared[ix + reduce_size];
          }
          workgroupBarrier();
        }

        let sum = sum_shared[0];
        let square_sum = sum_squared_shared[0];
        let mean = ${yt("sum",v)} / f32(uniforms.hidden_size);
        let inv_std_dev = inverseSqrt(${yt("square_sum",v)} / f32(uniforms.hidden_size) ${a?"":"- mean * mean"} + uniforms.epsilon);
        ${y?"mean_output[global_idx] = mean;":""}
        ${_?"inv_std_output[global_idx] = inv_std_dev;":""}

        for (var i: u32 = 0; i < stride; i++) {
          output[offset + i] = (output[offset + i] ${a?"":`- ${x}(mean)`}) *
            ${x}(inv_std_dev) * gamma[offset1d + i]
            ${m?"+ beta[offset1d + i]":""};
        }
      }`},k=[{dims:u,dataType:e[0].dataType}];return r>1&&k.push({dims:h,dataType:1}),r>2&&k.push({dims:h,dataType:1}),r>3&&k.push({dims:s,dataType:e[0].dataType}),{name:"SkipLayerNormalization",shaderCache:{hint:`${v};${y};${_};${b}`,inputDependencies:e.map((E,A)=>"type")},getShaderSource:I,getRunData:()=>({outputs:k,dispatchGroup:{x:Math.ceil(l/p)},programUniforms:w})}},Fh=(e,t)=>{hd(e.inputs);let r=[0];e.outputCount>1&&r.push(-3),e.outputCount>2&&r.push(-3),e.outputCount>3&&r.push(3),e.compute(fd(e.inputs,t,e.outputCount,!1),{outputs:r})}}),md,ir,gd,ua,yd,_d,jh,Kh,D0=U(()=>{te(),ie(),xe(),ae(),md=(e,t)=>{if(!e||e.length<1)throw new Error("too few inputs");if(t.axes.length!==0){if(t.axes.length!==t.starts.length||t.axes.length!==t.ends.length)throw new Error("axes, starts and ends must have the same length")}else if(t.starts.length!==t.ends.length)throw new Error("starts and ends must have the same length");e.slice(1).forEach((r,i)=>{if(e[i+1].dataType!==6&&e[i+1].dataType!==7)throw new Error(`Input ${i} must be an array of int32 or int64`)})},ir=(e,t)=>{let r=[];if(e.length>t)if(e[t].dataType===7)e[t].getBigInt64Array().forEach(i=>r.push(Number(i)));else if(e[t].dataType===6)e[t].getInt32Array().forEach(i=>r.push(Number(i)));else throw new Error(`Input ${t} must be an array of int32 or int64`);return r},gd=(e,t)=>{if(e.length>1){let r=ir(e,1),i=ir(e,2),a=ir(e,3);return a.length===0&&(a=[...Array(e[0].dims.length).keys()]),fe({starts:r,ends:i,axes:a})}else return t},ua=(e,t,r,i,a)=>{let s=e;return e<0&&(s+=r[i[t]]),a[t]<0?Math.max(0,Math.min(s,r[i[t]]-1)):Math.max(0,Math.min(s,r[i[t]]))},yd=(e,t,r)=>`fn calculateInputIndices(output_indices: ${t.type.indices}) -> ${e.type.indices} {
          var input_indices: ${e.type.indices};
          var carry = 0u;
          for (var i = ${r.length-1}; i >= 0; i--) {
            let input_shape_i = ${J("uniforms.input_shape","i",r.length)};
            let steps_i = ${J("uniforms.steps","i",r.length)};
            let signs_i = ${J("uniforms.signs","i",r.length)};
            let starts_i = ${J("uniforms.starts","i",r.length)};
            var output_index = ${t.indicesGet("output_indices","i")};
            var input_index = output_index * steps_i + starts_i + carry;
            carry = input_index / input_shape_i;
            input_index = input_index % input_shape_i;
            if (signs_i < 0) {
              input_index = input_shape_i - input_index - 1u + starts_i;
            }
            ${e.indicesSet("input_indices","i","input_index")};
          }
          return input_indices;
      }`,_d=(e,t)=>{let r=e[0].dims,i=R.size(r),a=t.axes.length>0?R.normalizeAxes(t.axes,r.length):[...Array(r.length).keys()],s=ir(e,4);s.forEach(v=>v!==0||(()=>{throw new Error("step cannot be 0")})),s.length===0&&(s=Array(a.length).fill(1));let n=t.starts.map((v,w)=>ua(v,w,r,a,s)),u=t.ends.map((v,w)=>ua(v,w,r,a,s));if(a.length!==n.length||a.length!==u.length)throw new Error("start, ends and axes should have the same number of elements");if(a.length!==r.length)for(let v=0;v<r.length;++v)a.includes(v)||(n.splice(v,0,0),u.splice(v,0,r[v]),s.splice(v,0,1));let l=s.map(v=>Math.sign(v));s.forEach((v,w,I)=>{if(v<0){let k=(u[w]-n[w])/v,E=n[w],A=E+k*s[w];n[w]=A,u[w]=E,I[w]=-v}});let p=r.slice(0);a.forEach((v,w)=>{p[v]=Math.ceil((u[v]-n[v])/s[v])});let h={dims:p,dataType:e[0].dataType},m=Q("output",e[0].dataType,p.length),g=N("input",e[0].dataType,e[0].dims.length),y=R.size(p),_=[{name:"outputSize",type:"u32"},{name:"starts",type:"u32",length:n.length},{name:"signs",type:"i32",length:l.length},{name:"steps",type:"u32",length:s.length}],b=[{type:12,data:y},{type:12,data:n},{type:6,data:l},{type:12,data:s},...ee(e[0].dims,p)],S=v=>`
      ${v.registerUniforms(_).declareVariables(g,m)}
        ${yd(g,m,r)}
        ${v.mainStart()}
          ${v.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.outputSize")}
          let output_indices = ${m.offsetToIndices("global_idx")};
          let input_indices = calculateInputIndices(output_indices);
          ${m.setByOffset("global_idx",g.getByIndices("input_indices"))}
      }`;return{name:"Slice",shaderCache:{hint:`${l.length}_${n.length}_${s.length}`,inputDependencies:["rank"]},getShaderSource:S,getRunData:()=>({outputs:[h],dispatchGroup:{x:Math.ceil(i/64)},programUniforms:b})}},jh=(e,t)=>{md(e.inputs,t);let r=gd(e.inputs,t);e.compute(_d(e.inputs,r),{inputs:[0]})},Kh=e=>{let t=e.starts,r=e.ends,i=e.axes;return fe({starts:t,ends:r,axes:i})}}),bd,$d,Zh,Xh,U0=U(()=>{te(),ie(),xe(),_t(),ae(),bd=e=>{if(!e||e.length!==1)throw new Error("Softmax op requires 1 input.")},$d=(e,t)=>{let r=e.inputs[0],i=r.dims,a=R.size(i),s=i.length,n=R.normalizeAxis(t.axis,s),u=n<i.length-1,l,p=[];u?(p=Array.from({length:s},(C,x)=>x),p[n]=s-1,p[s-1]=n,l=e.compute(Pe(r,p),{inputs:[r],outputs:[-1]})[0]):l=r;let h=l.dims,m=h[s-1],g=a/m,y=ve(m),_=m/y,b=64;g===1&&(b=256);let S=(C,x)=>x===4?`max(max(${C}.x, ${C}.y), max(${C}.z, ${C}.w))`:x===2?`max(${C}.x, ${C}.y)`:x===3?`max(max(${C}.x, ${C}.y), ${C}.z)`:C,v=N("x",l.dataType,l.dims,y),w=Q("result",l.dataType,l.dims,y),I=v.type.value,k=Te(l.dataType)==="f32"?`var threadMax = ${I}(-3.4028234663852886e+38f);`:`var threadMax = ${I}(-65504.0h);`,E=C=>`
      var<workgroup> rowMaxShared : ${I};
      var<workgroup> rowSumShared : ${I};
      var<workgroup> threadShared : array<${I}, ${b}>;

      fn getValue(row: i32, col: i32, row_stride: i32) -> ${I} {
        let index = row * row_stride + col;
        return x[index];
      }

      fn setValue(row: i32, col: i32, row_stride: i32, value: ${I}) {
        let index = row * row_stride + col;
        result[index] = value;
      }
      ${C.registerUniform("packedCols","i32").declareVariables(v,w)}
      ${C.mainStart(b)}
        let gindex = i32(global_idx);
        let lindex = i32(local_idx);
        const wg = ${b};
        let row = gindex / wg;
        let cols = uniforms.packedCols;
        let row_stride : i32 = uniforms.packedCols;

        // find the rows max
        ${k}
        for (var col = lindex; col < cols; col += wg) {
          let value = getValue(row, col, row_stride);
          threadMax = max(threadMax, value);
        }
        if (lindex < cols) {
          threadShared[lindex] = threadMax;
        }
        workgroupBarrier();

        var reduceSize = min(cols, wg);
        for (var currSize = reduceSize >> 1;  currSize > 0; currSize = reduceSize >> 1) {
          reduceSize = currSize + (reduceSize & 1);
          if (lindex < currSize) {
            threadShared[lindex] = max(threadShared[lindex], threadShared[lindex + reduceSize]);
          }
          workgroupBarrier();
        }
        if (lindex == 0) {
          rowMaxShared = ${I}(${S("threadShared[0]",y)});
        }
        workgroupBarrier();

        // find the rows sum
        var threadSum = ${I}(0.0);
        for (var col = lindex; col < cols; col += wg) {
          let subExp = exp(getValue(row, col, row_stride) - rowMaxShared);
          threadSum += subExp;
        }
        threadShared[lindex] = threadSum;
        workgroupBarrier();

        for (var currSize = wg >> 1;  currSize > 0; currSize = currSize >> 1) {
          if (lindex < currSize) {
            threadShared[lindex] = threadShared[lindex] + threadShared[lindex + currSize];
          }
          workgroupBarrier();
        }
        if (lindex == 0) {
          rowSumShared = ${I}(${yt("threadShared[0]",y)});
        }
        workgroupBarrier();

        // calculate final value for each element in the row
        for (var col = lindex; col < cols; col += wg) {
          var value = exp(getValue(row, col, row_stride) - rowMaxShared) / rowSumShared;
          // max operation protects against NaN since all values should be >=0
          value = max(value, ${I}(0.0));
          setValue(row, col, row_stride, value);
        }
      }`,A=e.compute({name:"Softmax",shaderCache:{hint:`${y};${b}`,inputDependencies:["type"]},getRunData:()=>({outputs:[{dims:h,dataType:l.dataType}],dispatchGroup:{x:g},programUniforms:[{type:6,data:_}]}),getShaderSource:E},{inputs:[l],outputs:[u?-1:0]})[0];u&&e.compute(Pe(A,p),{inputs:[A]})},Zh=(e,t)=>{bd(e.inputs),$d(e,t)},Xh=e=>fe({axis:e.axis})}),la,wd,vd,xd,Qh,P0=U(()=>{te(),ie(),ae(),la=e=>Array.from(e.getBigInt64Array(),Number),wd=e=>{if(!e||e.length!==2)throw new Error("Tile requires 2 inputs.");if(e[0].dataType!==1&&e[0].dataType!==10&&e[0].dataType!==6&&e[0].dataType!==12)throw new Error("Tile only support float, float16, int32, and uint32 data types");if(e[1].dataType!==7)throw new Error("Tile `repeats` input should be of int64 data type");if(e[1].dims.length!==1)throw new Error("Tile `repeats` input should be 1-D");if(la(e[1]).length!==e[0].dims.length)throw new Error("Tile `repeats` input should have same number of elements as rank of input data tensor")},vd=(e,t)=>{let r=[];for(let i=0;i<e.length;++i)r.push(e[i]*t[i]);return r},xd=(e,t)=>{let r=e[0].dims,i=t!=null?t:la(e[1]),a=vd(r,i),s=R.size(a),n=e[0].dataType,u=N("input",n,r.length),l=Q("output",n,a.length),p=h=>`
      const inputShape = ${u.indices(...r)};
      ${h.registerUniform("output_size","u32").declareVariables(u,l)}
      ${h.mainStart()}
      ${h.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.output_size")}
      let output_indices = ${l.offsetToIndices("global_idx")};
      var input_indices: ${u.type.indices};
      for (var i = 0; i < ${r.length}; i++) {
        let input_dim_i = ${u.indicesGet("uniforms.input_shape","i")};
        let input_dim_value = ${l.indicesGet("output_indices","i")}  % input_dim_i;

        ${u.indicesSet("input_indices","i","input_dim_value")}
      }
      ${l.setByOffset("global_idx",u.getByIndices("input_indices"))}
    }`;return{name:"Tile",shaderCache:{hint:`${i}`,inputDependencies:["rank"]},getRunData:()=>({outputs:[{dims:a,dataType:e[0].dataType}],dispatchGroup:{x:Math.ceil(s/64)},programUniforms:[{type:12,data:s},...ee(e[0].dims,a)]}),getShaderSource:p}},Qh=e=>{wd(e.inputs),e.compute(xd(e.inputs),{inputs:[0]})}}),Sd,kd,Yh,q0=U(()=>{te(),ie(),ae(),Sd=(e,t,r,i,a)=>{let s=Q("output_data",a,r.length,4),n=N("a_data",t[1].dataType,t[1].dims.length,4),u=N("b_data",t[2].dataType,t[2].dims.length,4),l=N("c_data",t[0].dataType,t[0].dims.length,4),p,h=(m,g,y)=>`select(${g}, ${m}, ${y})`;if(!i)p=s.setByOffset("global_idx",h(n.getByOffset("global_idx"),u.getByOffset("global_idx"),l.getByOffset("global_idx")));else{let m=(g,y,_="")=>{let b=`a_data[index_a${y}][component_a${y}]`,S=`b_data[index_b${y}][component_b${y}]`,v=`bool(c_data[index_c${y}] & (0xffu << (component_c${y} * 8)))`;return`
            let output_indices${y} = ${s.offsetToIndices(`global_idx * 4u + ${y}u`)};
            let offset_a${y} = ${n.broadcastedIndicesToOffset(`output_indices${y}`,s)};
            let offset_b${y} = ${u.broadcastedIndicesToOffset(`output_indices${y}`,s)};
            let offset_c${y} = ${l.broadcastedIndicesToOffset(`output_indices${y}`,s)};
            let index_a${y} = offset_a${y} / 4u;
            let index_b${y} = offset_b${y} / 4u;
            let index_c${y} = offset_c${y} / 4u;
            let component_a${y} = offset_a${y} % 4u;
            let component_b${y} = offset_b${y} % 4u;
            let component_c${y} = offset_c${y} % 4u;
            ${g}[${y}] = ${_}(${h(b,S,v)});
          `};a===9?p=`
            var data = vec4<u32>(0);
            ${m("data",0,"u32")}
            ${m("data",1,"u32")}
            ${m("data",2,"u32")}
            ${m("data",3,"u32")}
            output_data[global_idx] = dot(vec4<u32>(0x1, 0x100, 0x10000, 0x1000000), vec4<u32>(data));`:p=`
            ${m("output_data[global_idx]",0)}
            ${m("output_data[global_idx]",1)}
            ${m("output_data[global_idx]",2)}
            ${m("output_data[global_idx]",3)}
          `}return`
        ${e.registerUniform("vec_size","u32").declareVariables(l,n,u,s)}
        ${e.mainStart()}
        ${e.guardAgainstOutOfBoundsWorkgroupSizes("uniforms.vec_size")}
        ${p}
      }`},kd=e=>{let t=e[1].dims,r=e[2].dims,i=e[0].dims,a=e[1].dataType,s=!(R.areEqual(t,r)&&R.areEqual(r,i)),n=t,u=R.size(t);if(s){let p=Wt.calcShape(Wt.calcShape(t,r,!1),i,!1);if(!p)throw new Error("Can't perform where op on the given tensors");n=p,u=R.size(n)}let l=Math.ceil(u/4);return{name:"Where",shaderCache:{inputDependencies:["rank","rank","rank"]},getShaderSource:p=>Sd(p,e,n,s,a),getRunData:()=>({outputs:[{dims:n,dataType:a}],dispatchGroup:{x:Math.ceil(u/64/4)},programUniforms:[{type:12,data:l},...ee(i,t,r,n)]})}},Yh=e=>{e.compute(kd(e.inputs))}}),Jh,L0=U(()=>{t0(),Ga(),r0(),i0(),a0(),n0(),s0(),p0(),h0(),f0(),m0(),g0(),y0(),_0(),b0(),$0(),w0(),v0(),x0(),S0(),k0(),T0(),I0(),E0(),z0(),_h(),C0(),A0(),O0(),R0(),B0(),Va(),N0(),xh(),M0(),D0(),U0(),wh(),P0(),_t(),Ha(),q0(),Jh=new Map([["Abs",[Fp]],["Acos",[jp]],["Acosh",[Kp]],["Add",[Ec]],["ArgMax",[Wp,$a]],["ArgMin",[Lp,$a]],["Asin",[Zp]],["Asinh",[Xp]],["Atan",[Qp]],["Atanh",[Yp]],["Attention",[Vp]],["AveragePool",[Oh,Ah]],["BatchNormalization",[Gp]],["BiasAdd",[Hp]],["BiasSplitGelu",[Ic]],["Cast",[ec,Jp]],["Ceil",[rc]],["Clip",[tc]],["Concat",[Uc,Pc]],["Conv",[Ta,ka]],["ConvTranspose",[Zc,Kc]],["Cos",[ic]],["Cosh",[ac]],["CumSum",[Xc,Qc]],["DepthToSpace",[Yc,Jc]],["DequantizeLinear",[Ph,qh]],["Div",[zc]],["Einsum",[eh,th]],["Elu",[nc,ur]],["Equal",[Cc]],["Erf",[sc]],["Exp",[oc]],["Expand",[rh]],["FastGelu",[ih]],["Floor",[uc]],["FusedConv",[Ta,ka]],["Gather",[nh,ah]],["GatherElements",[ph,dh]],["GatherBlockQuantized",[uh,lh]],["GatherND",[sh,oh]],["Gelu",[lc]],["Gemm",[hh,ch]],["GlobalAveragePool",[Bh,Rh]],["GlobalMaxPool",[Uh,Dh]],["Greater",[Bc]],["GreaterOrEqual",[Mc]],["GridSample",[fh,mh]],["GroupQueryAttention",[Sh]],["HardSigmoid",[yc,gc]],["InstanceNormalization",[kh]],["LayerNormalization",[Th]],["LeakyRelu",[dc,ur]],["Less",[Nc]],["LessOrEqual",[Dc]],["Log",[kc]],["MatMul",[Ih]],["MatMulNBits",[Eh,zh]],["MaxPool",[Nh,Mh]],["Mul",[Ac]],["MultiHeadAttention",[yh,gh]],["Neg",[cc]],["Not",[pc]],["Pad",[Ch]],["Pow",[Oc]],["QuickGelu",[Tc,ur]],["Range",[Lh]],["Reciprocal",[hc]],["ReduceMin",[Mp]],["ReduceMean",[Ap]],["ReduceMax",[Np]],["ReduceSum",[Up]],["ReduceProd",[Dp]],["ReduceL1",[Op]],["ReduceL2",[Rp]],["ReduceLogSum",[qp]],["ReduceLogSumExp",[Bp]],["ReduceSumSquare",[Pp]],["Relu",[fc]],["Resize",[Gh,Hh]],["RotaryEmbedding",[vh]],["ScatterND",[Vh,Wh]],["Sigmoid",[mc]],["Sin",[_c]],["Sinh",[bc]],["Slice",[jh,Kh]],["SkipLayerNormalization",[Fh]],["Split",[bh,$h]],["Sqrt",[$c]],["Softmax",[Zh,Xh]],["Sub",[Rc]],["Tan",[wc]],["Tanh",[vc]],["ThresholdedRelu",[Sc,ur]],["Tile",[Qh]],["Transpose",[bp,$p]],["Where",[Yh]]])}),ef,W0=U(()=>{We(),ot(),ae(),ef=class{constructor(e){this.backend=e,this.repo=new Map,this.attributesBound=!1}getArtifact(e){return this.repo.get(e)}setArtifact(e,t){this.repo.set(e,t)}run(e,t,r,i,a){rt(e.programInfo.name);let s=this.backend.device,n=this.backend.getComputePassEncoder();this.backend.writeTimestamp(this.backend.pendingDispatchNumber*2);let u=[];for(let p of t)u.push({binding:u.length,resource:{buffer:p.buffer}});for(let p of r)u.push({binding:u.length,resource:{buffer:p.buffer}});a&&u.push({binding:u.length,resource:a});let l=s.createBindGroup({layout:e.computePipeline.getBindGroupLayout(0),entries:u,label:e.programInfo.name});if(this.backend.sessionStatus==="capturing"){let p={kernelId:this.backend.currentKernelId,computePipeline:e.computePipeline,bindGroup:l,dispatchGroup:i};this.backend.capturedCommandList.get(this.backend.currentSessionId).push(p)}n.setPipeline(e.computePipeline),n.setBindGroup(0,l),n.dispatchWorkgroups(...i),this.backend.writeTimestamp(this.backend.pendingDispatchNumber*2+1),this.backend.pendingDispatchNumber++,(this.backend.pendingDispatchNumber>=this.backend.maxDispatchNumber||this.backend.queryType==="at-passes")&&this.backend.endComputePass(),this.backend.pendingDispatchNumber>=this.backend.maxDispatchNumber&&this.backend.flush(),Xe(e.programInfo.name)}dispose(){}build(e,t){rt(e.name);let r=this.backend.device,i=[];[{feature:"shader-f16",extension:"f16"},{feature:"subgroups",extension:"subgroups"}].forEach(p=>{r.features.has(p.feature)&&i.push(`enable ${p.extension};`)});let a=_p(t,this.backend.device.limits),s=e.getShaderSource(a),n=`${i.join(`
`)}
${a.additionalImplementations}
${s}`,u=r.createShaderModule({code:n,label:e.name});de("verbose",()=>`[WebGPU] ${e.name} shader code: ${n}`);let l=r.createComputePipeline({compute:{module:u,entryPoint:"main"},layout:"auto",label:e.name});return Xe(e.name),{programInfo:e,computePipeline:l,uniformVariablesInfo:a.variablesInfo}}normalizeDispatchGroupSize(e){let t=typeof e=="number"?e:e.x,r=typeof e=="number"?1:e.y||1,i=typeof e=="number"?1:e.z||1,a=this.backend.device.limits.maxComputeWorkgroupsPerDimension;if(t<=a&&r<=a&&i<=a)return[t,r,i];let s=t*r*i,n=Math.ceil(Math.sqrt(s));if(n>a){if(n=Math.ceil(Math.cbrt(s)),n>a)throw new Error("Total dispatch size exceeds WebGPU maximum.");return[n,n,n]}else return[n,n,1]}}}),tf={};Gt(tf,{WebGpuBackend:()=>rf});var Td,Id,Ed,rf,V0=U(()=>{We(),te(),ot(),hp(),Jg(),L0(),W0(),Td=(e,t)=>{if(t.length!==e.length)throw new Error(`inputDependencies length ${t.length} is not equal to inputTensors length ${e.length}.`);let r=[];for(let i=0;i<e.length;++i){let a=e[i].dataType;switch(t[i]){case"none":{r.push("");break}case"type":{r.push(`${a}`);break}case"rank":{let s=e[i].dims.length;r.push(`${a};${s}`);break}case"dims":{let s=e[i].dims.join(",");r.push(`${a};${s}`);break}default:throw new Error(`unsupported input dependency: ${t[i]}`)}}return r.join("|")},Id=(e,t,r)=>{var a,s,n;let i=e.name;return(a=e.shaderCache)!=null&&a.hint&&(i+="["+e.shaderCache.hint+"]"),i+=":"+r+`:${Td(t,(n=(s=e.shaderCache)==null?void 0:s.inputDependencies)!=null?n:new Array(t.length).fill("dims"))}`,i},Ed=class{constructor(e){e&&(this.architecture=e.architecture,this.vendor=e.vendor)}isArchitecture(e){return this.architecture===e}isVendor(e){return this.vendor===e}},rf=class{constructor(){this.currentSessionId=null,this.currentKernelId=null,this.commandEncoder=null,this.computePassEncoder=null,this.maxDispatchNumber=16,this.pendingDispatchNumber=0,this.pendingKernels=[],this.pendingQueries=new Map,this.sessionStatus="default",this.capturedCommandList=new Map,this.capturedPendingKernels=new Map,this.sessionExternalDataMapping=new Map}get currentKernelCustomData(){if(this.currentKernelId===null)throw new Error("currentKernelCustomData(): currentKernelId is null. (should not happen)");let e=this.kernelCustomData.get(this.currentKernelId);return e||(e={},this.kernelCustomData.set(this.currentKernelId,e)),e}async initialize(e,t){var u;this.env=e;let r=[],i={requiredLimits:{maxComputeWorkgroupStorageSize:t.limits.maxComputeWorkgroupStorageSize,maxComputeWorkgroupsPerDimension:t.limits.maxComputeWorkgroupsPerDimension,maxStorageBufferBindingSize:t.limits.maxStorageBufferBindingSize,maxBufferSize:t.limits.maxBufferSize,maxComputeInvocationsPerWorkgroup:t.limits.maxComputeInvocationsPerWorkgroup,maxComputeWorkgroupSizeX:t.limits.maxComputeWorkgroupSizeX,maxComputeWorkgroupSizeY:t.limits.maxComputeWorkgroupSizeY,maxComputeWorkgroupSizeZ:t.limits.maxComputeWorkgroupSizeZ},requiredFeatures:r},a=l=>t.features.has(l)&&r.push(l)&&!0;a("chromium-experimental-timestamp-query-inside-passes")||a("timestamp-query"),a("shader-f16"),a("subgroups"),this.device=await t.requestDevice(i);let s=t,n=(u=t.info)!=null?u:typeof s.requestAdapterInfo=="function"?await s.requestAdapterInfo():void 0;this.adapterInfo=new Ed(n),this.gpuDataManager=gp(this),this.programManager=new ef(this),this.kernels=new Map,this.kernelPersistentData=new Map,this.kernelCustomData=new Map,Pa(e.logLevel,!!e.debug),this.device.onuncapturederror=l=>{l.error instanceof GPUValidationError&&console.error(`An uncaught WebGPU validation error was raised: ${l.error.message}`)},Object.defineProperty(this.env.webgpu,"device",{value:this.device,writable:!1,enumerable:!0,configurable:!0}),Object.defineProperty(this.env.webgpu,"adapter",{value:t,writable:!1,enumerable:!0,configurable:!1}),this.setQueryType()}dispose(){var e;typeof this.querySet<"u"&&this.querySet.destroy(),this.gpuDataManager.dispose(),this.device&&((e=this.env)!=null&&e.webgpu)&&this.device.lost.then(()=>{delete this.env.webgpu.device})}getCommandEncoder(){return this.commandEncoder||(this.commandEncoder=this.device.createCommandEncoder()),this.commandEncoder}getComputePassEncoder(){if(!this.computePassEncoder){let e=this.getCommandEncoder(),t={};this.queryType==="at-passes"&&(t.timestampWrites={querySet:this.querySet,beginningOfPassWriteIndex:this.pendingDispatchNumber*2,endOfPassWriteIndex:this.pendingDispatchNumber*2+1}),this.computePassEncoder=e.beginComputePass(t)}return this.computePassEncoder}endComputePass(){this.computePassEncoder&&(this.computePassEncoder.end(),this.computePassEncoder=null)}flush(){if(!this.commandEncoder)return;rt(),this.endComputePass();let e;this.queryType!=="none"&&(this.commandEncoder.resolveQuerySet(this.querySet,0,this.pendingDispatchNumber*2,this.queryResolveBuffer,0),e=this.device.createBuffer({size:this.pendingDispatchNumber*2*8,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),this.pendingQueries.set(e,this.pendingKernels),this.pendingKernels=[],this.commandEncoder.copyBufferToBuffer(this.queryResolveBuffer,0,e,0,this.pendingDispatchNumber*2*8)),this.device.queue.submit([this.commandEncoder.finish()]),this.gpuDataManager.refreshPendingBuffers(),this.commandEncoder=null,this.pendingDispatchNumber=0,this.queryType!=="none"&&e.mapAsync(GPUMapMode.READ).then(()=>{var i;let t=new BigUint64Array(e.getMappedRange()),r=this.pendingQueries.get(e);for(let a=0;a<t.length/2;a++){let s=r[a],n=s.kernelId,u=this.kernels.get(n),l=u.kernelType,p=u.kernelName,h=s.programName,m=s.inputTensorViews,g=s.outputTensorViews,y=t[a*2],_=t[a*2+1];typeof this.queryTimeBase>"u"&&(this.queryTimeBase=y);let b=Number(y-this.queryTimeBase),S=Number(_-this.queryTimeBase);if(!Number.isSafeInteger(b)||!Number.isSafeInteger(S))throw new RangeError("incorrect timestamp range");if((i=this.env.webgpu.profiling)!=null&&i.ondata)this.env.webgpu.profiling.ondata({version:1,inputsMetadata:m.map(v=>({dims:v.dims,dataType:st(v.dataType)})),outputsMetadata:g.map(v=>({dims:v.dims,dataType:st(v.dataType)})),kernelId:n,kernelType:l,kernelName:p,programName:h,startTime:b,endTime:S});else{let v="";m.forEach((I,k)=>{v+=`input[${k}]: [${I.dims}] | ${st(I.dataType)}, `});let w="";g.forEach((I,k)=>{w+=`output[${k}]: [${I.dims}] | ${st(I.dataType)}, `}),console.log(`[profiling] kernel "${n}|${l}|${p}|${h}" ${v}${w}start time: ${b} ns, execution time: ${S-b} ns`)}Lr("GPU",`${h}::${y}::${_}`)}e.unmap(),this.pendingQueries.delete(e)}),Xe()}run(e,t,r,i,a,s){rt(e.name);let n=[];for(let w=0;w<t.length;++w){let I=t[w].data;if(I===0)continue;let k=this.gpuDataManager.get(I);if(!k)throw new Error(`no GPU data for input: ${I}`);n.push(k)}let{outputs:u,dispatchGroup:l,programUniforms:p}=e.getRunData(t),h=r.length===0?u.map((w,I)=>I):r;if(h.length!==u.length)throw new Error(`Output size ${h.length} must be equal to ${u.length}.`);let m=[],g=[];for(let w=0;w<u.length;++w){if(!Number.isInteger(h[w])||h[w]<-3||h[w]>=s)throw new Error(`Invalid output index: ${h[w]}`);if(h[w]===-3)continue;let I=h[w]===-1,k=h[w]===-2,E=I||k?a(u[w].dataType,u[w].dims):i(h[w],u[w].dataType,u[w].dims);if(m.push(E),E.data===0)continue;let A=this.gpuDataManager.get(E.data);if(!A)throw new Error(`no GPU data for output: ${E.data}`);if(I&&this.temporaryData.push(A),k){let C=this.kernelPersistentData.get(this.currentKernelId);C||(C=[],this.kernelPersistentData.set(this.currentKernelId,C)),C.push(A)}g.push(A)}if(n.length!==t.length||g.length!==m.length){if(g.length===0)return Xe(e.name),m;throw new Error(`Program ${e.name} has zero-sized tensor(s) in inputs or outputs. This is not supported now.`)}let y;if(p){let w=0,I=[];p.forEach(C=>{let x=typeof C.data=="number"?[C.data]:C.data;if(x.length===0)return;let D=C.type===10?2:4,M,P;C.type===10?(P=x.length>4?16:x.length>2?8:x.length*D,M=x.length>4?16:D*x.length):(P=x.length<=2?x.length*D:16,M=16),w=Math.ceil(w/P)*P,I.push(w);let K=C.type===10?8:4;w+=x.length>4?Math.ceil(x.length/K)*M:x.length*D});let k=16;w=Math.ceil(w/k)*k;let E=new ArrayBuffer(w);p.forEach((C,x)=>{let D=I[x],M=typeof C.data=="number"?[C.data]:C.data;if(C.type===6)new Int32Array(E,D,M.length).set(M);else if(C.type===12)new Uint32Array(E,D,M.length).set(M);else if(C.type===10)new Uint16Array(E,D,M.length).set(M);else if(C.type===1)new Float32Array(E,D,M.length).set(M);else throw new Error(`Unsupported uniform type: ${st(C.type)}`)});let A=this.gpuDataManager.create(w,GPUBufferUsage.COPY_DST|GPUBufferUsage.UNIFORM);this.device.queue.writeBuffer(A.buffer,0,E,0,w),this.gpuDataManager.release(A.id),y={offset:0,size:w,buffer:A.buffer}}let _=this.programManager.normalizeDispatchGroupSize(l),b=_[1]===1&&_[2]===1,S=Id(e,t,b),v=this.programManager.getArtifact(S);if(v||(v=this.programManager.build(e,_),this.programManager.setArtifact(S,v),de("info",()=>`[artifact] key: ${S}, programName: ${e.name}`)),p&&v.uniformVariablesInfo){if(p.length!==v.uniformVariablesInfo.length)throw new Error(`Uniform variables count mismatch: expect ${v.uniformVariablesInfo.length}, got ${p.length} in program "${v.programInfo.name}".`);for(let w=0;w<p.length;w++){let I=p[w],k=I.type,E=typeof I.data=="number"?1:I.data.length,[A,C]=v.uniformVariablesInfo[w];if(k!==A||E!==C)throw new Error(`Uniform variable ${w} mismatch: expect type ${A} with size ${C}, got type ${k} with size ${E} in program "${v.programInfo.name}".`)}}if(de("info",()=>`[ProgramManager] run "${e.name}" (key=${S}) with ${_[0]}x${_[1]}x${_[2]}`),this.queryType!=="none"||this.sessionStatus==="capturing"){let w={kernelId:this.currentKernelId,programName:v.programInfo.name,inputTensorViews:t,outputTensorViews:m};this.pendingKernels.push(w),this.sessionStatus==="capturing"&&this.capturedPendingKernels.get(this.currentSessionId).push(w)}return this.programManager.run(v,n,g,_,y),Xe(e.name),m}upload(e,t){this.gpuDataManager.upload(e,t)}memcpy(e,t){this.gpuDataManager.memcpy(e,t)}async download(e,t){await this.gpuDataManager.download(e,t)}alloc(e){return this.gpuDataManager.create(e).id}free(e){return this.gpuDataManager.release(e)}createKernel(e,t,r,i){let a=Jh.get(e);if(!a)throw new Error(`kernel not implemented: ${e}`);let s={kernelType:e,kernelName:i,kernelEntry:a[0],attributes:[a[1],r]};this.kernels.set(t,s)}releaseKernel(e){let t=this.kernelPersistentData.get(e);if(t){for(let r of t)this.gpuDataManager.release(r.id);this.kernelPersistentData.delete(e)}this.kernelCustomData.delete(e),this.kernels.delete(e)}computeKernel(e,t,r){let i=this.kernels.get(e);if(!i)throw new Error(`kernel not created: ${e}`);let a=i.kernelType,s=i.kernelName,n=i.kernelEntry,u=i.attributes;if(this.currentKernelId!==null)throw new Error(`kernel "[${a}] ${s}" is not allowed to be called recursively`);this.currentKernelId=e,u[0]&&(u[1]=u[0](u[1]),u[0]=void 0),de("info",()=>`[WebGPU] Start to run kernel "[${a}] ${s}"...`);let l=this.env.debug;this.temporaryData=[];try{return l&&this.device.pushErrorScope("validation"),n(t,u[1]),0}catch(p){return r.push(Promise.resolve(`[WebGPU] Kernel "[${a}] ${s}" failed. ${p}`)),1}finally{l&&r.push(this.device.popErrorScope().then(p=>p?`GPU validation error for kernel "[${a}] ${s}": ${p.message}`:null));for(let p of this.temporaryData)this.gpuDataManager.release(p.id);this.temporaryData=[],this.currentKernelId=null}}registerBuffer(e,t,r,i){let a=this.sessionExternalDataMapping.get(e);a||(a=new Map,this.sessionExternalDataMapping.set(e,a));let s=a.get(t),n=this.gpuDataManager.registerExternalBuffer(r,i,s);return a.set(t,[n,r]),n}unregisterBuffers(e){let t=this.sessionExternalDataMapping.get(e);t&&(t.forEach(r=>this.gpuDataManager.unregisterExternalBuffer(r[0])),this.sessionExternalDataMapping.delete(e))}getBuffer(e){let t=this.gpuDataManager.get(e);if(!t)throw new Error(`no GPU data for buffer: ${e}`);return t.buffer}createDownloader(e,t,r){return async()=>{let i=await ya(this,e,t);return qa(i.buffer,r)}}writeTimestamp(e){this.queryType==="inside-passes"&&this.computePassEncoder.writeTimestamp(this.querySet,e)}setQueryType(){var e;this.queryType="none",(((e=this.env.webgpu.profiling)==null?void 0:e.mode)==="default"||(typeof this.env.trace>"u"?this.env.wasm.trace:this.env.trace))&&(this.device.features.has("chromium-experimental-timestamp-query-inside-passes")?this.queryType="inside-passes":this.device.features.has("timestamp-query")&&(this.queryType="at-passes"),this.queryType!=="none"&&typeof this.querySet>"u"&&(this.querySet=this.device.createQuerySet({type:"timestamp",count:this.maxDispatchNumber*2}),this.queryResolveBuffer=this.device.createBuffer({size:this.maxDispatchNumber*2*8,usage:GPUBufferUsage.COPY_SRC|GPUBufferUsage.QUERY_RESOLVE})))}captureBegin(){de("info","captureBegin"),this.capturedCommandList.get(this.currentSessionId)||this.capturedCommandList.set(this.currentSessionId,[]),this.capturedPendingKernels.get(this.currentSessionId)||this.capturedPendingKernels.set(this.currentSessionId,[]),this.flush(),this.sessionStatus="capturing"}captureEnd(){de("info","captureEnd"),this.flush(),this.sessionStatus="default"}replay(){de("info","replay"),this.sessionStatus="replaying";let e=this.capturedCommandList.get(this.currentSessionId),t=this.capturedPendingKernels.get(this.currentSessionId),r=e.length;this.pendingKernels=[];for(let i=0;i<r;i++){let a=this.getComputePassEncoder(),s=e[i];this.writeTimestamp(this.pendingDispatchNumber*2),a.setPipeline(s.computePipeline),a.setBindGroup(0,s.bindGroup),a.dispatchWorkgroups(...s.dispatchGroup),this.writeTimestamp(this.pendingDispatchNumber*2+1),this.pendingDispatchNumber++,this.queryType!=="none"&&this.pendingKernels.push(t[i]),(this.pendingDispatchNumber>=this.maxDispatchNumber||this.queryType==="at-passes")&&this.endComputePass(),this.pendingDispatchNumber>=this.maxDispatchNumber&&this.flush()}this.flush(),this.sessionStatus="default"}onCreateSession(){this.gpuDataManager.onCreateSession()}onReleaseSession(e){this.unregisterBuffers(e),this.capturedCommandList.has(e)&&this.capturedCommandList.delete(e),this.capturedPendingKernels.has(e)&&this.capturedPendingKernels.delete(e),this.gpuDataManager.onReleaseSession(e)}onRunStart(e){this.currentSessionId=e,this.setQueryType()}}}),af={};Gt(af,{init:()=>nf});var Mr,zd,nf,G0=U(()=>{te(),ot(),ie(),Yg(),Mr=class sf{constructor(t,r,i,a){this.module=t,this.dataType=r,this.data=i,this.dims=a}getFloat32Array(){if(this.dataType!==1)throw new Error("Invalid data type");let t=R.size(this.dims);return t===0?new Float32Array:new Float32Array(this.module.HEAP8.buffer,this.data,t)}getBigInt64Array(){if(this.dataType!==7)throw new Error("Invalid data type");let t=R.size(this.dims);return t===0?new BigInt64Array:new BigInt64Array(this.module.HEAP8.buffer,this.data,t)}getInt32Array(){if(this.dataType!==6)throw new Error("Invalid data type");let t=R.size(this.dims);return t===0?new Int32Array:new Int32Array(this.module.HEAP8.buffer,this.data,t)}getUint16Array(){if(this.dataType!==10&&this.dataType!==4)throw new Error("Invalid data type");let t=R.size(this.dims);return t===0?new Uint16Array:new Uint16Array(this.module.HEAP8.buffer,this.data,t)}reshape(t){if(R.size(t)!==R.size(this.dims))throw new Error("Invalid new shape");return new sf(this.module,this.dataType,this.data,t)}},zd=class{constructor(e,t,r){this.module=e,this.backend=t,this.customDataOffset=0,this.customDataSize=0,this.adapterInfo=t.adapterInfo;let i=e.PTR_SIZE,a=r/e.PTR_SIZE,s=i===4?"i32":"i64";this.opKernelContext=Number(e.getValue(i*a++,s));let n=Number(e.getValue(i*a++,s));this.outputCount=Number(e.getValue(i*a++,s)),this.customDataOffset=Number(e.getValue(i*a++,"*")),this.customDataSize=Number(e.getValue(i*a++,s));let u=[];for(let l=0;l<n;l++){let p=Number(e.getValue(i*a++,s)),h=Number(e.getValue(i*a++,"*")),m=Number(e.getValue(i*a++,s)),g=[];for(let y=0;y<m;y++)g.push(Number(e.getValue(i*a++,s)));u.push(new Mr(e,p,h,g))}this.inputs=u}get kernelCustomData(){return this.backend.currentKernelCustomData}get customDataBuffer(){return this.module.HEAPU8.subarray(this.customDataOffset,this.customDataOffset+this.customDataSize)}compute(e,t){var n,u,l;let r=(u=(n=t==null?void 0:t.inputs)==null?void 0:n.map(p=>typeof p=="number"?this.inputs[p]:p))!=null?u:this.inputs,i=(l=t==null?void 0:t.outputs)!=null?l:[],a=(p,h,m)=>new Mr(this.module,h,this.output(p,m),m),s=(p,h)=>{let m=zt(p,h);if(!m)throw new Error(`Unsupported data type: ${p}`);let g=m>0?this.backend.gpuDataManager.create(m).id:0;return new Mr(this.module,p,g,h)};return this.backend.run(e,r,i,a,s,this.outputCount)}output(e,t){let r=this.module.stackSave();try{let i=this.module.PTR_SIZE,a=i===4?"i32":"i64",s=this.module.stackAlloc((1+t.length)*i);this.module.setValue(s,t.length,a);for(let n=0;n<t.length;n++)this.module.setValue(s+i*(n+1),t[n],a);return this.module._JsepOutput(this.opKernelContext,e,s)}catch(i){throw new Error(`Failed to generate kernel's output[${e}] with dims [${t}]. If you are running with pre-allocated output, please make sure the output type/dims are correct. Error: ${i}`)}finally{this.module.stackRestore(r)}}},nf=async(e,t,r,i)=>{let a=t.jsepInit;if(!a)throw new Error("Failed to initialize JSEP. The WebAssembly module is not built with JSEP support.");if(e==="webgpu"){let s=(V0(),pr(tf)).WebGpuBackend,n=new s;await n.initialize(r,i),a("webgpu",[n,u=>n.alloc(Number(u)),u=>n.free(u),(u,l,p,h=!1)=>{if(h)de("verbose",()=>`[WebGPU] jsepCopyGpuToGpu: src=${Number(u)}, dst=${Number(l)}, size=${Number(p)}`),n.memcpy(Number(u),Number(l));else{de("verbose",()=>`[WebGPU] jsepCopyCpuToGpu: dataOffset=${Number(u)}, gpuDataId=${Number(l)}, size=${Number(p)}`);let m=t.HEAPU8.subarray(Number(u>>>0),Number(u>>>0)+Number(p));n.upload(Number(l),m)}},async(u,l,p)=>{de("verbose",()=>`[WebGPU] jsepCopyGpuToCpu: gpuDataId=${u}, dataOffset=${l}, size=${p}`),await n.download(Number(u),()=>t.HEAPU8.subarray(Number(l)>>>0,Number(l+p)>>>0))},(u,l,p)=>n.createKernel(u,Number(l),p,t.UTF8ToString(t._JsepGetNodeName(Number(l)))),u=>n.releaseKernel(u),(u,l,p,h)=>{de("verbose",()=>`[WebGPU] jsepRun: sessionHandle=${p}, kernel=${u}, contextDataOffset=${l}`);let m=new zd(t,n,Number(l));return n.computeKernel(Number(u),m,h)},()=>n.captureBegin(),()=>n.captureEnd(),()=>n.replay()])}else{let s=new mp(r);a("webnn",[s,()=>s.reserveTensorId(),n=>s.releaseTensorId(n),async(n,u,l,p,h)=>s.ensureTensor(n,u,l,p,h),(n,u)=>{s.uploadTensor(n,u)},async(n,u)=>s.downloadTensor(n,u),(n,u)=>s.registerMLContext(n,u),!!r.trace])}}}),Cd,Qa,Ya,mt,Ad,da,Kr,Ja,en,pa,tn,rn,an,of=U(()=>{We(),Zg(),Xg(),te(),Nt(),Na(),lp(),Cd=(e,t)=>{_e()._OrtInit(e,t)!==0&&ge("Can't initialize onnxruntime.")},Qa=async e=>{Cd(e.wasm.numThreads,Vr(e.logLevel))},Ya=async(e,t)=>{var i,a;(a=(i=_e()).asyncInit)==null||a.call(i);let r=e.webgpu.adapter;if(t==="webgpu"){if(typeof navigator>"u"||!navigator.gpu)throw new Error("WebGPU is not supported in current environment");if(r){if(typeof r.limits!="object"||typeof r.features!="object"||typeof r.requestDevice!="function")throw new Error("Invalid GPU adapter set in `env.webgpu.adapter`. It must be a GPUAdapter object.")}else{let s=e.webgpu.powerPreference;if(s!==void 0&&s!=="low-power"&&s!=="high-performance")throw new Error(`Invalid powerPreference setting: "${s}"`);let n=e.webgpu.forceFallbackAdapter;if(n!==void 0&&typeof n!="boolean")throw new Error(`Invalid forceFallbackAdapter setting: "${n}"`);if(r=await navigator.gpu.requestAdapter({powerPreference:s,forceFallbackAdapter:n}),!r)throw new Error('Failed to get GPU adapter. You may need to enable flag "--enable-unsafe-webgpu" if you are using Chrome.')}}if(t==="webnn"&&(typeof navigator>"u"||!navigator.ml))throw new Error("WebNN is not supported in current environment");{let s=(G0(),pr(af)).init;t==="webgpu"&&await s("webgpu",_e(),e,r),t==="webnn"&&await s("webnn",_e(),e)}},mt=new Map,Ad=e=>{let t=_e(),r=t.stackSave();try{let i=t.PTR_SIZE,a=t.stackAlloc(2*i);t._OrtGetInputOutputCount(e,a,a+i)!==0&&ge("Can't get session input/output count.");let s=i===4?"i32":"i64";return[Number(t.getValue(a,s)),Number(t.getValue(a+i,s))]}finally{t.stackRestore(r)}},da=(e,t)=>{let r=_e(),i=r.stackSave(),a=0;try{let s=r.PTR_SIZE,n=r.stackAlloc(2*s);r._OrtGetInputOutputMetadata(e,t,n,n+s)!==0&&ge("Can't get session input/output metadata.");let u=Number(r.getValue(n,"*"));a=Number(r.getValue(n+s,"*"));let l=r.HEAP32[a/4];if(l===0)return[u,0];let p=r.HEAPU32[a/4+1],h=[];for(let m=0;m<p;m++){let g=Number(r.getValue(a+8+m*s,"*"));h.push(g!==0?r.UTF8ToString(g):Number(r.getValue(a+8+(m+p)*s,"*")))}return[u,l,h]}finally{r.stackRestore(i),a!==0&&r._OrtFree(a)}},Kr=e=>{let t=_e(),r=t._malloc(e.byteLength);if(r===0)throw new Error(`Can't create a session. failed to allocate a buffer of size ${e.byteLength}.`);return t.HEAPU8.set(e,r),[r,e.byteLength]},Ja=async(e,t)=>{var m,g,y,_,b,S;let r,i,a=_e();Array.isArray(e)?[r,i]=e:e.buffer===a.HEAPU8.buffer?[r,i]=[e.byteOffset,e.byteLength]:[r,i]=Kr(e);let s=0,n=0,u=0,l=[],p=[],h=[];try{if([n,l]=await up(t),(t==null?void 0:t.externalData)&&a.mountExternalData){let M=[];for(let P of t.externalData){let K=typeof P=="string"?P:P.path;M.push(Ua(typeof P=="string"?P:P.data).then(Z=>{a.mountExternalData(K,Z)}))}await Promise.all(M)}for(let M of(m=t==null?void 0:t.executionProviders)!=null?m:[])if((typeof M=="string"?M:M.name)==="webnn"){if(a.shouldTransferToMLTensor=!1,typeof M!="string"){let P=M,K=P==null?void 0:P.context,Z=P==null?void 0:P.gpuDevice,O=P==null?void 0:P.deviceType,G=P==null?void 0:P.powerPreference;K?a.currentContext=K:Z?a.currentContext=await a.webnnCreateMLContext(Z):a.currentContext=await a.webnnCreateMLContext({deviceType:O,powerPreference:G})}else a.currentContext=await a.webnnCreateMLContext();break}s=await a._OrtCreateSession(r,i,n),(g=a.webgpuOnCreateSession)==null||g.call(a,s),s===0&&ge("Can't create a session."),(y=a.jsepOnCreateSession)==null||y.call(a),a.currentContext&&(a.webnnRegisterMLContext(s,a.currentContext),a.currentContext=void 0,a.shouldTransferToMLTensor=!0);let[v,w]=Ad(s),I=!!(t!=null&&t.enableGraphCapture),k=[],E=[],A=[],C=[],x=[];for(let M=0;M<v;M++){let[P,K,Z]=da(s,M);P===0&&ge("Can't get an input name."),p.push(P);let O=a.UTF8ToString(P);k.push(O),A.push(K===0?{name:O,isTensor:!1}:{name:O,isTensor:!0,type:st(K),shape:Z})}for(let M=0;M<w;M++){let[P,K,Z]=da(s,M+v);P===0&&ge("Can't get an output name."),h.push(P);let O=a.UTF8ToString(P);E.push(O),C.push(K===0?{name:O,isTensor:!1}:{name:O,isTensor:!0,type:st(K),shape:Z});{if(I&&(t==null?void 0:t.preferredOutputLocation)===void 0){x.push("gpu-buffer");continue}let G=typeof(t==null?void 0:t.preferredOutputLocation)=="string"?t.preferredOutputLocation:(b=(_=t==null?void 0:t.preferredOutputLocation)==null?void 0:_[O])!=null?b:"cpu",F=a.webnnIsGraphOutput;if(G==="cpu"&&F&&F(s,O)){x.push("ml-tensor-cpu-output");continue}if(G!=="cpu"&&G!=="cpu-pinned"&&G!=="gpu-buffer"&&G!=="ml-tensor")throw new Error(`Not supported preferred output location: ${G}.`);if(I&&G!=="gpu-buffer")throw new Error(`Not supported preferred output location: ${G}. Only 'gpu-buffer' location is supported when enableGraphCapture is true.`);x.push(G)}}let D=null;return x.some(M=>M==="gpu-buffer"||M==="ml-tensor"||M==="ml-tensor-cpu-output")&&(u=a._OrtCreateBinding(s),u===0&&ge("Can't create IO binding."),D={handle:u,outputPreferredLocations:x,outputPreferredLocationsEncoded:x.map(M=>M==="ml-tensor-cpu-output"?"ml-tensor":M).map(M=>ma(M))}),mt.set(s,[s,p,h,D,I,!1]),[s,k,E,A,C]}catch(v){throw p.forEach(w=>a._OrtFree(w)),h.forEach(w=>a._OrtFree(w)),u!==0&&a._OrtReleaseBinding(u)!==0&&ge("Can't release IO binding."),s!==0&&a._OrtReleaseSession(s)!==0&&ge("Can't release session."),v}finally{a._free(r),n!==0&&a._OrtReleaseSessionOptions(n)!==0&&ge("Can't release session options."),l.forEach(v=>a._free(v)),(S=a.unmountExternalData)==null||S.call(a)}},en=e=>{var l,p,h;let t=_e(),r=mt.get(e);if(!r)throw new Error(`cannot release session. invalid session id: ${e}`);let[i,a,s,n,u]=r;n&&(u&&t._OrtClearBoundOutputs(n.handle)!==0&&ge("Can't clear bound outputs."),t._OrtReleaseBinding(n.handle)!==0&&ge("Can't release IO binding.")),(l=t.jsepOnReleaseSession)==null||l.call(t,e),(p=t.webnnOnReleaseSession)==null||p.call(t,e),(h=t.webgpuOnReleaseSession)==null||h.call(t,e),a.forEach(m=>t._OrtFree(m)),s.forEach(m=>t._OrtFree(m)),t._OrtReleaseSession(i)!==0&&ge("Can't release session."),mt.delete(e)},pa=async(e,t,r,i,a,s,n=!1)=>{if(!e){t.push(0);return}let u=_e(),l=u.PTR_SIZE,p=e[0],h=e[1],m=e[3],g=m,y,_;if(p==="string"&&(m==="gpu-buffer"||m==="ml-tensor"))throw new Error("String tensor is not supported on GPU.");if(n&&m!=="gpu-buffer")throw new Error(`External buffer must be provided for input/output index ${s} when enableGraphCapture is true.`);if(m==="gpu-buffer"){let v=e[2].gpuBuffer;_=zt(Et(p),h);{let w=u.jsepRegisterBuffer;if(!w)throw new Error('Tensor location "gpu-buffer" is not supported without using WebGPU.');y=w(i,s,v,_)}}else if(m==="ml-tensor"){let v=e[2].mlTensor;_=zt(Et(p),h);let w=u.webnnRegisterMLTensor;if(!w)throw new Error('Tensor location "ml-tensor" is not supported without using WebNN.');y=w(i,v,Et(p),h)}else{let v=e[2];if(Array.isArray(v)){_=l*v.length,y=u._malloc(_),r.push(y);for(let w=0;w<v.length;w++){if(typeof v[w]!="string")throw new TypeError(`tensor data at index ${w} is not a string`);u.setValue(y+w*l,Ze(v[w],r),"*")}}else{let w=u.webnnIsGraphInput,I=u.webnnIsGraphOutput;if(p!=="string"&&w&&I){let k=u.UTF8ToString(a);if(w(i,k)||I(i,k)){let E=Et(p);_=zt(E,h),g="ml-tensor";let A=u.webnnCreateTemporaryTensor,C=u.webnnUploadTensor;if(!A||!C)throw new Error('Tensor location "ml-tensor" is not supported without using WebNN.');let x=await A(i,E,h);C(x,new Uint8Array(v.buffer,v.byteOffset,v.byteLength)),y=x}else _=v.byteLength,y=u._malloc(_),r.push(y),u.HEAPU8.set(new Uint8Array(v.buffer,v.byteOffset,_),y)}else _=v.byteLength,y=u._malloc(_),r.push(y),u.HEAPU8.set(new Uint8Array(v.buffer,v.byteOffset,_),y)}}let b=u.stackSave(),S=u.stackAlloc(4*h.length);try{h.forEach((w,I)=>u.setValue(S+I*l,w,l===4?"i32":"i64"));let v=u._OrtCreateTensor(Et(p),y,_,S,h.length,ma(g));v===0&&ge(`Can't create tensor for input/output. session=${i}, index=${s}.`),t.push(v)}finally{u.stackRestore(b)}},tn=async(e,t,r,i,a,s)=>{var K,Z,O,G;let n=_e(),u=n.PTR_SIZE,l=mt.get(e);if(!l)throw new Error(`cannot run inference. invalid session id: ${e}`);let p=l[0],h=l[1],m=l[2],g=l[3],y=l[4],_=l[5],b=t.length,S=i.length,v=0,w=[],I=[],k=[],E=[],A=[],C=n.stackSave(),x=n.stackAlloc(b*u),D=n.stackAlloc(b*u),M=n.stackAlloc(S*u),P=n.stackAlloc(S*u);try{[v,w]=op(s),Ct("wasm prepareInputOutputTensor");for(let V=0;V<b;V++)await pa(r[V],I,E,e,h[t[V]],t[V],y);for(let V=0;V<S;V++)await pa(a[V],k,E,e,m[i[V]],b+i[V],y);At("wasm prepareInputOutputTensor");for(let V=0;V<b;V++)n.setValue(x+V*u,I[V],"*"),n.setValue(D+V*u,h[t[V]],"*");for(let V=0;V<S;V++)n.setValue(M+V*u,k[V],"*"),n.setValue(P+V*u,m[i[V]],"*");if(g&&!_){let{handle:V,outputPreferredLocations:se,outputPreferredLocationsEncoded:q}=g;if(h.length!==b)throw new Error(`input count from feeds (${b}) is expected to be always equal to model's input count (${h.length}).`);Ct("wasm bindInputsOutputs");for(let H=0;H<b;H++){let X=t[H];await n._OrtBindInput(V,h[X],I[H])!==0&&ge(`Can't bind input[${H}] for session=${e}.`)}for(let H=0;H<S;H++){let X=i[H];(K=a[H])!=null&&K[3]?(A.push(k[H]),n._OrtBindOutput(V,m[X],k[H],0)!==0&&ge(`Can't bind pre-allocated output[${H}] for session=${e}.`)):n._OrtBindOutput(V,m[X],0,q[X])!==0&&ge(`Can't bind output[${H}] to ${se[H]} for session=${e}.`)}At("wasm bindInputsOutputs"),mt.set(e,[p,h,m,g,y,!0])}(Z=n.jsepOnRunStart)==null||Z.call(n,p),(O=n.webnnOnRunStart)==null||O.call(n,p);let F;g?F=await n._OrtRunWithBinding(p,g.handle,S,M,v):F=await n._OrtRun(p,D,x,b,P,S,M,v),F!==0&&ge("failed to call OrtRun().");let Y=[],he=[];Ct("wasm ProcessOutputTensor");for(let V=0;V<S;V++){let se=Number(n.getValue(M+V*u,"*"));if(se===k[V]||A.includes(k[V])){Y.push(a[V]),se!==k[V]&&n._OrtReleaseTensor(se)!==0&&ge("Can't release tensor.");continue}let q=n.stackSave(),H=n.stackAlloc(4*u),X=!1,L,me=0;try{n._OrtGetTensorData(se,H,H+u,H+2*u,H+3*u)!==0&&ge(`Can't access output tensor data on index ${V}.`);let qe=u===4?"i32":"i64",Se=Number(n.getValue(H,qe));me=n.getValue(H+u,"*");let Ae=n.getValue(H+u*2,"*"),Oe=Number(n.getValue(H+u*3,qe)),Ne=[];for(let be=0;be<Oe;be++)Ne.push(Number(n.getValue(Ae+be*u,qe)));n._OrtFree(Ae)!==0&&ge("Can't free memory for tensor dims.");let Re=Ne.reduce((be,re)=>be*re,1);L=st(Se);let ut=g==null?void 0:g.outputPreferredLocations[i[V]];if(L==="string"){if(ut==="gpu-buffer"||ut==="ml-tensor")throw new Error("String tensor is not supported on GPU.");let be=[];for(let re=0;re<Re;re++){let Me=n.getValue(me+re*u,"*"),hr=n.getValue(me+(re+1)*u,"*"),Ht=re===Re-1?void 0:hr-Me;be.push(n.UTF8ToString(Me,Ht))}Y.push([L,Ne,be,"cpu"])}else if(ut==="gpu-buffer"&&Re>0){let be=n.jsepGetBuffer;if(!be)throw new Error('preferredLocation "gpu-buffer" is not supported without using WebGPU.');let re=be(me),Me=zt(Se,Re);if(Me===void 0||!Ma(L))throw new Error(`Unsupported data type: ${L}`);X=!0,Y.push([L,Ne,{gpuBuffer:re,download:n.jsepCreateDownloader(re,Me,L),dispose:()=>{n._OrtReleaseTensor(se)!==0&&ge("Can't release tensor.")}},"gpu-buffer"])}else if(ut==="ml-tensor"&&Re>0){let be=n.webnnEnsureTensor,re=n.webnnIsGraphInputOutputTypeSupported;if(!be||!re)throw new Error('preferredLocation "ml-tensor" is not supported without using WebNN.');if(zt(Se,Re)===void 0||!Da(L))throw new Error(`Unsupported data type: ${L}`);if(!re(e,L,!1))throw new Error(`preferredLocation "ml-tensor" for ${L} output is not supported by current WebNN Context.`);let Me=await be(e,me,Se,Ne,!1);X=!0,Y.push([L,Ne,{mlTensor:Me,download:n.webnnCreateMLTensorDownloader(me,L),dispose:()=>{n.webnnReleaseTensorId(me),n._OrtReleaseTensor(se)}},"ml-tensor"])}else if(ut==="ml-tensor-cpu-output"&&Re>0){let be=n.webnnCreateMLTensorDownloader(me,L)(),re=Y.length;X=!0,he.push((async()=>{let Me=[re,await be];return n.webnnReleaseTensorId(me),n._OrtReleaseTensor(se),Me})()),Y.push([L,Ne,[],"cpu"])}else{let be=Zr(L),re=new be(Re);new Uint8Array(re.buffer,re.byteOffset,re.byteLength).set(n.HEAPU8.subarray(me,me+re.byteLength)),Y.push([L,Ne,re,"cpu"])}}finally{n.stackRestore(q),L==="string"&&me&&n._free(me),X||n._OrtReleaseTensor(se)}}g&&!y&&(n._OrtClearBoundOutputs(g.handle)!==0&&ge("Can't clear bound outputs."),mt.set(e,[p,h,m,g,y,!1]));for(let[V,se]of await Promise.all(he))Y[V][2]=se;return At("wasm ProcessOutputTensor"),Y}finally{(G=n.webnnOnRunEnd)==null||G.call(n,p),n.stackRestore(C),I.forEach(F=>n._OrtReleaseTensor(F)),k.forEach(F=>n._OrtReleaseTensor(F)),E.forEach(F=>n._free(F)),v!==0&&n._OrtReleaseRunOptions(v),w.forEach(F=>n._free(F))}},rn=e=>{let t=_e(),r=mt.get(e);if(!r)throw new Error("invalid session id");let i=r[0],a=t._OrtEndProfiling(i);a===0&&ge("Can't get an profile file name."),t._OrtFree(a)},an=e=>{let t=[];for(let r of e){let i=r[2];!Array.isArray(i)&&"buffer"in i&&t.push(i.buffer)}return t}}),gt,Be,Pt,ar,nr,Dr,ca,Ur,kt,Tt,Od,uf,lf,df,pf,cf,hf,ff,mf=U(()=>{We(),of(),Nt(),Ra(),gt=()=>!!we.wasm.proxy&&typeof document<"u",Pt=!1,ar=!1,nr=!1,Ur=new Map,kt=(e,t)=>{let r=Ur.get(e);r?r.push(t):Ur.set(e,[t])},Tt=()=>{if(Pt||!ar||nr||!Be)throw new Error("worker not ready")},Od=e=>{switch(e.data.type){case"init-wasm":Pt=!1,e.data.err?(nr=!0,ca[1](e.data.err)):(ar=!0,ca[0]()),Dr&&(URL.revokeObjectURL(Dr),Dr=void 0);break;case"init-ep":case"copy-from":case"create":case"release":case"run":case"end-profiling":{let t=Ur.get(e.data.type);e.data.err?t.shift()[1](e.data.err):t.shift()[0](e.data.out);break}}},uf=async()=>{if(!ar){if(Pt)throw new Error("multiple calls to 'initWasm()' detected.");if(nr)throw new Error("previous call to 'initWasm()' failed.");if(Pt=!0,gt())return new Promise((e,t)=>{Be==null||Be.terminate(),np().then(([r,i])=>{try{Be=i,Be.onerror=s=>t(s),Be.onmessage=Od,ca=[e,t];let a={type:"init-wasm",in:we};!a.in.wasm.wasmPaths&&(r||fa)&&(a.in.wasm.wasmPaths={wasm:new URL(""+new URL("ort-wasm-simd-threaded.jsep-DC5y_g6C.wasm",import.meta.url).href,import.meta.url).href}),Be.postMessage(a),Dr=r}catch(a){t(a)}},t)});try{await Ba(we.wasm),await Qa(we),ar=!0}catch(e){throw nr=!0,e}finally{Pt=!1}}},lf=async e=>{if(gt())return Tt(),new Promise((t,r)=>{kt("init-ep",[t,r]);let i={type:"init-ep",in:{epName:e,env:we}};Be.postMessage(i)});await Ya(we,e)},df=async e=>gt()?(Tt(),new Promise((t,r)=>{kt("copy-from",[t,r]);let i={type:"copy-from",in:{buffer:e}};Be.postMessage(i,[e.buffer])})):Kr(e),pf=async(e,t)=>{if(gt()){if(t!=null&&t.preferredOutputLocation)throw new Error('session option "preferredOutputLocation" is not supported for proxy.');return Tt(),new Promise((r,i)=>{kt("create",[r,i]);let a={type:"create",in:{model:e,options:{...t}}},s=[];e instanceof Uint8Array&&s.push(e.buffer),Be.postMessage(a,s)})}else return Ja(e,t)},cf=async e=>{if(gt())return Tt(),new Promise((t,r)=>{kt("release",[t,r]);let i={type:"release",in:e};Be.postMessage(i)});en(e)},hf=async(e,t,r,i,a,s)=>{if(gt()){if(r.some(n=>n[3]!=="cpu"))throw new Error("input tensor on GPU is not supported for proxy.");if(a.some(n=>n))throw new Error("pre-allocated output tensor is not supported for proxy.");return Tt(),new Promise((n,u)=>{kt("run",[n,u]);let l=r,p={type:"run",in:{sessionId:e,inputIndices:t,inputs:l,outputIndices:i,options:s}};Be.postMessage(p,an(l))})}else return tn(e,t,r,i,a,s)},ff=async e=>{if(gt())return Tt(),new Promise((t,r)=>{kt("end-profiling",[t,r]);let i={type:"end-profiling",in:e};Be.postMessage(i)});rn(e)}}),ha,Rd,gf,H0=U(()=>{We(),mf(),te(),Oa(),lp(),ha=(e,t)=>{switch(e.location){case"cpu":return[e.type,e.dims,e.data,"cpu"];case"gpu-buffer":return[e.type,e.dims,{gpuBuffer:e.gpuBuffer},"gpu-buffer"];case"ml-tensor":return[e.type,e.dims,{mlTensor:e.mlTensor},"ml-tensor"];default:throw new Error(`invalid data location: ${e.location} for ${t()}`)}},Rd=e=>{switch(e[3]){case"cpu":return new tt(e[0],e[2],e[1]);case"gpu-buffer":{let t=e[0];if(!Ma(t))throw new Error(`not supported data type: ${t} for deserializing GPU tensor`);let{gpuBuffer:r,download:i,dispose:a}=e[2];return tt.fromGpuBuffer(r,{dataType:t,dims:e[1],download:i,dispose:a})}case"ml-tensor":{let t=e[0];if(!Da(t))throw new Error(`not supported data type: ${t} for deserializing MLTensor tensor`);let{mlTensor:r,download:i,dispose:a}=e[2];return tt.fromMLTensor(r,{dataType:t,dims:e[1],download:i,dispose:a})}default:throw new Error(`invalid data location: ${e[3]}`)}},gf=class{async fetchModelAndCopyToWasmMemory(e){return df(await Ua(e))}async loadModel(e,t){rt();let r;typeof e=="string"?r=await this.fetchModelAndCopyToWasmMemory(e):r=e,[this.sessionId,this.inputNames,this.outputNames,this.inputMetadata,this.outputMetadata]=await pf(r,t),Xe()}async dispose(){return cf(this.sessionId)}async run(e,t,r){var m;rt();let i=[],a=[];Object.entries(e).forEach(g=>{let y=g[0],_=g[1],b=this.inputNames.indexOf(y);if(b===-1)throw new Error(`invalid input '${y}'`);i.push(_),a.push(b)});let s=[],n=[];Object.entries(t).forEach(g=>{let y=g[0],_=g[1],b=this.outputNames.indexOf(y);if(b===-1)throw new Error(`invalid output '${y}'`);s.push(_),n.push(b)});let u=i.map((g,y)=>ha(g,()=>`input "${this.inputNames[a[y]]}"`)),l=s.map((g,y)=>g?ha(g,()=>`output "${this.outputNames[n[y]]}"`):null),p=await hf(this.sessionId,a,u,n,l,r),h={};for(let g=0;g<p.length;g++)h[this.outputNames[n[g]]]=(m=s[g])!=null?m:Rd(p[g]);return Xe(),h}startProfiling(){}endProfiling(){ff(this.sessionId)}}}),yf={};Gt(yf,{OnnxruntimeWebAssemblyBackend:()=>za,initializeFlags:()=>Ea,wasmBackend:()=>_f});var Ea,za,_f,F0=U(()=>{We(),mf(),H0(),Ea=()=>{(typeof we.wasm.initTimeout!="number"||we.wasm.initTimeout<0)&&(we.wasm.initTimeout=0);let e=we.wasm.simd;if(typeof e!="boolean"&&e!==void 0&&e!=="fixed"&&e!=="relaxed"&&(console.warn(`Property "env.wasm.simd" is set to unknown value "${e}". Reset it to \`false\` and ignore SIMD feature checking.`),we.wasm.simd=!1),typeof we.wasm.proxy!="boolean"&&(we.wasm.proxy=!1),typeof we.wasm.trace!="boolean"&&(we.wasm.trace=!1),typeof we.wasm.numThreads!="number"||!Number.isInteger(we.wasm.numThreads)||we.wasm.numThreads<=0)if(typeof self<"u"&&!self.crossOriginIsolated)we.wasm.numThreads=1;else{let t=typeof navigator>"u"?Og("node:os").cpus().length:navigator.hardwareConcurrency;we.wasm.numThreads=Math.min(4,Math.ceil((t||1)/2))}},za=class{async init(e){Ea(),await uf(),await lf(e)}async createInferenceSessionHandler(e,t){let r=new gf;return await r.loadModel(e,t),r}},_f=new za});We();We();We();var j0="1.27.0",Z0=Jd;{let e=(F0(),pr(yf)).wasmBackend;qt("webgpu",e,5),qt("webnn",e,5),qt("cpu",e,10),qt("wasm",e,10)}Object.defineProperty(we.versions,"web",{value:j0,enumerable:!0});export{Yd as InferenceSession,Lr as TRACE,Ct as TRACE_EVENT_BEGIN,At as TRACE_EVENT_END,rt as TRACE_FUNC_BEGIN,Xe as TRACE_FUNC_END,tt as Tensor,Z0 as default,we as env,qt as registerBackend};
