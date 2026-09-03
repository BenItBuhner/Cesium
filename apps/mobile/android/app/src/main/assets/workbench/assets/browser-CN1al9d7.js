import{g as Ut}from"./index-CgyH0vwZ.js";function It(ve,Ee){for(var ce=0;ce<Ee.length;ce++){const ue=Ee[ce];if(typeof ue!="string"&&!Array.isArray(ue)){for(const fe in ue)if(fe!=="default"&&!(fe in ve)){const be=Object.getOwnPropertyDescriptor(ue,fe);be&&Object.defineProperty(ve,fe,be.get?be:{enumerable:!0,get:()=>ue[fe]})}}}return Object.freeze(Object.defineProperty(ve,Symbol.toStringTag,{value:"Module"}))}var Ie={exports:{}},Ke;function Nt(){return Ke||(Ke=1,(function(ve){(Ee=>{var ce=Object.defineProperty,ue=Object.getOwnPropertyDescriptor,fe=Object.getOwnPropertyNames,be=Object.prototype.hasOwnProperty,et=(e,t)=>{for(var r in t)ce(e,r,{get:t[r],enumerable:!0})},tt=(e,t,r,o)=>{if(t&&typeof t=="object"||typeof t=="function")for(let m of fe(t))!be.call(e,m)&&m!==r&&ce(e,m,{get:()=>t[m],enumerable:!(o=ue(t,m))||o.enumerable});return e},nt=e=>tt(ce({},"__esModule",{value:!0}),e),ae=(e,t,r)=>new Promise((o,m)=>{var g=l=>{try{v(r.next(l))}catch(y){m(y)}},f=l=>{try{v(r.throw(l))}catch(y){m(y)}},v=l=>l.done?o(l.value):Promise.resolve(l.value).then(g,f);v((r=r.apply(e,t)).next())}),Se={};et(Se,{analyzeMetafile:()=>Et,analyzeMetafileSync:()=>jt,build:()=>bt,buildSync:()=>St,context:()=>xt,default:()=>At,formatMessages:()=>_t,formatMessagesSync:()=>Tt,initialize:()=>Ot,stop:()=>Pt,transform:()=>kt,transformSync:()=>$t,version:()=>vt}),Ee.exports=nt(Se);function Ne(e){let t=o=>{if(o===null)r.write8(0);else if(typeof o=="boolean")r.write8(1),r.write8(+o);else if(typeof o=="number")r.write8(2),r.write32(o|0);else if(typeof o=="string")r.write8(3),r.write(ee(o));else if(o instanceof Uint8Array)r.write8(4),r.write(o);else if(o instanceof Array){r.write8(5),r.write32(o.length);for(let m of o)t(m)}else{let m=Object.keys(o);r.write8(6),r.write32(m.length);for(let g of m)r.write(ee(g)),t(o[g])}},r=new Me;return r.write32(0),r.write32(e.id<<1|+!e.isRequest),t(e.value),Ue(r.buf,r.len-4,0),r.buf.subarray(0,r.len)}function rt(e){let t=()=>{switch(r.read8()){case 0:return null;case 1:return!!r.read8();case 2:return r.read32();case 3:return de(r.read());case 4:return r.read();case 5:{let f=r.read32(),v=[];for(let l=0;l<f;l++)v.push(t());return v}case 6:{let f=r.read32(),v={};for(let l=0;l<f;l++)v[de(r.read())]=t();return v}default:throw new Error("Invalid packet")}},r=new Me(e),o=r.read32(),m=(o&1)===0;o>>>=1;let g=t();if(r.ptr!==e.length)throw new Error("Invalid packet");return{id:o,isRequest:m,value:g}}var Me=class{constructor(e=new Uint8Array(1024)){this.buf=e,this.len=0,this.ptr=0}_write(e){if(this.len+e>this.buf.length){let t=new Uint8Array((this.len+e)*2);t.set(this.buf),this.buf=t}return this.len+=e,this.len-e}write8(e){let t=this._write(1);this.buf[t]=e}write32(e){let t=this._write(4);Ue(this.buf,e,t)}write(e){let t=this._write(4+e.length);Ue(this.buf,e.length,t),this.buf.set(e,t+4)}_read(e){if(this.ptr+e>this.buf.length)throw new Error("Invalid packet");return this.ptr+=e,this.ptr-e}read8(){return this.buf[this._read(1)]}read32(){return Fe(this.buf,this._read(4))}read(){let e=this.read32(),t=new Uint8Array(e),r=this._read(t.length);return t.set(this.buf.subarray(r,r+e)),t}},ee,de,Re;if(typeof TextEncoder!="undefined"&&typeof TextDecoder!="undefined"){let e=new TextEncoder,t=new TextDecoder;ee=r=>e.encode(r),de=r=>t.decode(r),Re='new TextEncoder().encode("")'}else if(typeof Buffer!="undefined")ee=e=>Buffer.from(e),de=e=>{let{buffer:t,byteOffset:r,byteLength:o}=e;return Buffer.from(t,r,o).toString()},Re='Buffer.from("")';else throw new Error("No UTF-8 codec found");if(!(ee("")instanceof Uint8Array))throw new Error(`Invariant violation: "${Re} instanceof Uint8Array" is incorrectly false

This indicates that your JavaScript environment is broken. You cannot use
esbuild in this environment because esbuild relies on this invariant. This
is not a problem with esbuild. You need to fix your environment instead.
`);function Fe(e,t){return(e[t++]|e[t++]<<8|e[t++]<<16|e[t++]<<24)>>>0}function Ue(e,t,r){e[r++]=t,e[r++]=t>>8,e[r++]=t>>16,e[r++]=t>>24}var ne=String.fromCharCode;function X(e,t,r){const o=e[t];let m=1,g=0;for(let f=0;f<t;f++)e[f]===10?(m++,g=0):g++;throw new SyntaxError(r||(t===e.length?"Unexpected end of input while parsing JSON":o>=32&&o<=126?`Unexpected character ${ne(o)} in JSON at position ${t} (line ${m}, column ${g})`:`Unexpected byte 0x${o.toString(16)} in JSON at position ${t} (line ${m}, column ${g})`))}function st(e){if(!(e instanceof Uint8Array))throw new Error("JSON input must be a Uint8Array");const t=[],r=[],o=[],m=e.length;let g=null,f=0,v,l=0;for(;l<m;){let y=e[l++];if(y<=32)continue;let k;switch(f===2&&g===null&&y!==34&&y!==125&&X(e,--l),y){case 116:{(e[l++]!==114||e[l++]!==117||e[l++]!==101)&&X(e,--l),k=!0;break}case 102:{(e[l++]!==97||e[l++]!==108||e[l++]!==115||e[l++]!==101)&&X(e,--l),k=!1;break}case 110:{(e[l++]!==117||e[l++]!==108||e[l++]!==108)&&X(e,--l),k=null;break}case 45:case 46:case 48:case 49:case 50:case 51:case 52:case 53:case 54:case 55:case 56:case 57:{let T=l;for(k=ne(y),y=e[l];;){switch(y){case 43:case 45:case 46:case 48:case 49:case 50:case 51:case 52:case 53:case 54:case 55:case 56:case 57:case 101:case 69:{k+=ne(y),y=e[++l];continue}}break}k=+k,isNaN(k)&&X(e,--T,"Invalid number");break}case 34:{for(k="";l>=m&&X(e,m),y=e[l++],y!==34;)if(y===92)switch(e[l++]){case 34:k+='"';break;case 47:k+="/";break;case 92:k+="\\";break;case 98:k+="\b";break;case 102:k+="\f";break;case 110:k+=`
`;break;case 114:k+="\r";break;case 116:k+="	";break;case 117:{let T=0;for(let I=0;I<4;I++)y=e[l++],T<<=4,y>=48&&y<=57?T|=y-48:y>=97&&y<=102?T|=y+-87:y>=65&&y<=70?T|=y+-55:X(e,--l);k+=ne(T);break}default:X(e,--l);break}else if(y<=127)k+=ne(y);else if((y&224)===192)k+=ne((y&31)<<6|e[l++]&63);else if((y&240)===224)k+=ne((y&15)<<12|(e[l++]&63)<<6|e[l++]&63);else if((y&248)==240){let T=(y&7)<<18|(e[l++]&63)<<12|(e[l++]&63)<<6|e[l++]&63;T>65535&&(T-=65536,k+=ne(T>>10&1023|55296),T=56320|T&1023),k+=ne(T)}k[0];break}case 91:{k=[],t.push(g),r.push(v),o.push(f),g=null,v=k,f=1;continue}case 123:{k={},t.push(g),r.push(v),o.push(f),g=null,v=k,f=2;continue}case 93:{f!==1&&X(e,--l),k=v,g=t.pop(),v=r.pop(),f=o.pop();break}case 125:{f!==2&&X(e,--l),k=v,g=t.pop(),v=r.pop(),f=o.pop();break}default:X(e,--l)}for(y=e[l];y<=32;)y=e[++l];switch(f){case 0:{if(l===m)return k;break}case 1:{if(v.push(k),y===44){l++;continue}if(y===93)continue;break}case 2:{if(g===null){if(g=k,y===58){l++;continue}}else{if(v[g]=k,g=null,y===44){l++;continue}if(y===125)continue}break}}break}X(e,l)}var J=JSON.stringify,Ve="warning",Be="silent";function pe(e,t){const r=[];for(const o of e){if(Y(o,t),o.indexOf(",")>=0)throw new Error(`Invalid ${t}: ${o}`);r.push(o)}return r.join(",")}var $e=()=>null,L=e=>typeof e=="boolean"?null:"a boolean",C=e=>typeof e=="string"?null:"a string",Te=e=>e instanceof RegExp?null:"a RegExp object",he=e=>typeof e=="number"&&e===(e|0)?null:"an integer",it=e=>typeof e=="number"&&e===(e|0)&&e>=0&&e<=65535?null:"a valid port number",Le=e=>typeof e=="function"?null:"a function",re=e=>Array.isArray(e)?null:"an array",q=e=>Array.isArray(e)&&e.every(t=>typeof t=="string")?null:"an array of strings",Q=e=>typeof e=="object"&&e!==null&&!Array.isArray(e)?null:"an object",lt=e=>typeof e=="object"&&e!==null?null:"an array or an object",ot=e=>e instanceof WebAssembly.Module?null:"a WebAssembly.Module",We=e=>typeof e=="object"&&!Array.isArray(e)?null:"an object or null",ze=e=>typeof e=="string"||typeof e=="boolean"?null:"a string or a boolean",at=e=>typeof e=="string"||typeof e=="object"&&e!==null&&!Array.isArray(e)?null:"a string or an object",Ge=e=>typeof e=="string"||Array.isArray(e)&&e.every(t=>typeof t=="string")?null:"a string or an array of strings",Je=e=>typeof e=="string"||e instanceof Uint8Array?null:"a string or a Uint8Array",ct=e=>typeof e=="string"||e instanceof URL?null:"a string or a URL";function i(e,t,r,o){let m=e[r];if(t[r+""]=!0,m===void 0)return;let g=o(m);if(g!==null)throw new Error(`${J(r)} must be ${g}`);return m}function z(e,t,r){for(let o in e)if(!(o in t))throw new Error(`Invalid option ${r}: ${J(o)}`)}function ut(e){let t=Object.create(null),r=i(e,t,"wasmURL",ct),o=i(e,t,"wasmModule",ot),m=i(e,t,"worker",L);return z(e,t,"in initialize() call"),{wasmURL:r,wasmModule:o,worker:m}}function qe(e){let t;if(e!==void 0){t=Object.create(null);for(let r in e){let o=e[r];if(typeof o=="string"||o===!1)t[r]=o;else throw new Error(`Expected ${J(r)} in mangle cache to map to either a string or false`)}}return t}function je(e,t,r,o,m){let g=i(t,r,"color",L),f=i(t,r,"logLevel",C),v=i(t,r,"logLimit",he);g!==void 0?e.push(`--color=${g}`):o&&e.push("--color=true"),e.push(`--log-level=${f||m}`),e.push(`--log-limit=${v||0}`)}function Y(e,t,r){if(typeof e!="string")throw new Error(`Expected value for ${t}${r!==void 0?" "+J(r):""} to be a string, got ${typeof e} instead`);return e}function Ye(e,t,r){let o=i(t,r,"legalComments",C),m=i(t,r,"sourceRoot",C),g=i(t,r,"sourcesContent",L),f=i(t,r,"target",Ge),v=i(t,r,"format",C),l=i(t,r,"globalName",C),y=i(t,r,"mangleProps",Te),k=i(t,r,"reserveProps",Te),T=i(t,r,"mangleQuoted",L),I=i(t,r,"minify",L),R=i(t,r,"minifySyntax",L),M=i(t,r,"minifyWhitespace",L),F=i(t,r,"minifyIdentifiers",L),O=i(t,r,"lineLimit",he),W=i(t,r,"drop",q),P=i(t,r,"dropLabels",q),j=i(t,r,"charset",C),w=i(t,r,"treeShaking",L),d=i(t,r,"ignoreAnnotations",L),s=i(t,r,"jsx",C),c=i(t,r,"jsxFactory",C),h=i(t,r,"jsxFragment",C),_=i(t,r,"jsxImportSource",C),S=i(t,r,"jsxDev",L),u=i(t,r,"jsxSideEffects",L),p=i(t,r,"define",Q),E=i(t,r,"logOverride",Q),n=i(t,r,"supported",Q),a=i(t,r,"pure",q),x=i(t,r,"keepNames",L),b=i(t,r,"platform",C),D=i(t,r,"tsconfigRaw",at),B=i(t,r,"absPaths",q);if(o&&e.push(`--legal-comments=${o}`),m!==void 0&&e.push(`--source-root=${m}`),g!==void 0&&e.push(`--sources-content=${g}`),f&&e.push(`--target=${pe(Array.isArray(f)?f:[f],"target")}`),v&&e.push(`--format=${v}`),l&&e.push(`--global-name=${l}`),b&&e.push(`--platform=${b}`),D&&e.push(`--tsconfig-raw=${typeof D=="string"?D:JSON.stringify(D)}`),I&&e.push("--minify"),R&&e.push("--minify-syntax"),M&&e.push("--minify-whitespace"),F&&e.push("--minify-identifiers"),O&&e.push(`--line-limit=${O}`),j&&e.push(`--charset=${j}`),w!==void 0&&e.push(`--tree-shaking=${w}`),d&&e.push("--ignore-annotations"),W)for(let $ of W)e.push(`--drop:${Y($,"drop")}`);if(P&&e.push(`--drop-labels=${pe(P,"drop label")}`),B&&e.push(`--abs-paths=${pe(B,"abs paths")}`),y&&e.push(`--mangle-props=${Ce(y)}`),k&&e.push(`--reserve-props=${Ce(k)}`),T!==void 0&&e.push(`--mangle-quoted=${T}`),s&&e.push(`--jsx=${s}`),c&&e.push(`--jsx-factory=${c}`),h&&e.push(`--jsx-fragment=${h}`),_&&e.push(`--jsx-import-source=${_}`),S&&e.push("--jsx-dev"),u&&e.push("--jsx-side-effects"),p)for(let $ in p){if($.indexOf("=")>=0)throw new Error(`Invalid define: ${$}`);e.push(`--define:${$}=${Y(p[$],"define",$)}`)}if(E)for(let $ in E){if($.indexOf("=")>=0)throw new Error(`Invalid log override: ${$}`);e.push(`--log-override:${$}=${Y(E[$],"log override",$)}`)}if(n)for(let $ in n){if($.indexOf("=")>=0)throw new Error(`Invalid supported: ${$}`);const V=n[$];if(typeof V!="boolean")throw new Error(`Expected value for supported ${J($)} to be a boolean, got ${typeof V} instead`);e.push(`--supported:${$}=${V}`)}if(a)for(let $ of a)e.push(`--pure:${Y($,"pure")}`);x&&e.push("--keep-names")}function ft(e,t,r,o,m){var g;let f=[],v=[],l=Object.create(null),y=null,k=null;je(f,t,l,r,o),Ye(f,t,l);let T=i(t,l,"sourcemap",ze),I=i(t,l,"bundle",L),R=i(t,l,"splitting",L),M=i(t,l,"preserveSymlinks",L),F=i(t,l,"metafile",L),O=i(t,l,"outfile",C),W=i(t,l,"outdir",C),P=i(t,l,"outbase",C),j=i(t,l,"tsconfig",C),w=i(t,l,"resolveExtensions",q),d=i(t,l,"nodePaths",q),s=i(t,l,"mainFields",q),c=i(t,l,"conditions",q),h=i(t,l,"external",q),_=i(t,l,"packages",C),S=i(t,l,"alias",Q),u=i(t,l,"loader",Q),p=i(t,l,"outExtension",Q),E=i(t,l,"publicPath",C),n=i(t,l,"entryNames",C),a=i(t,l,"chunkNames",C),x=i(t,l,"assetNames",C),b=i(t,l,"inject",q),D=i(t,l,"banner",Q),B=i(t,l,"footer",Q),$=i(t,l,"entryPoints",lt),V=i(t,l,"absWorkingDir",C),N=i(t,l,"stdin",Q),U=(g=i(t,l,"write",L))!=null?g:m,H=i(t,l,"allowOverwrite",L),G=i(t,l,"mangleCache",Q);if(l.plugins=!0,z(t,l,`in ${e}() call`),T&&f.push(`--sourcemap${T===!0?"":`=${T}`}`),I&&f.push("--bundle"),H&&f.push("--allow-overwrite"),R&&f.push("--splitting"),M&&f.push("--preserve-symlinks"),F&&f.push("--metafile"),O&&f.push(`--outfile=${O}`),W&&f.push(`--outdir=${W}`),P&&f.push(`--outbase=${P}`),j&&f.push(`--tsconfig=${j}`),_&&f.push(`--packages=${_}`),w&&f.push(`--resolve-extensions=${pe(w,"resolve extension")}`),E&&f.push(`--public-path=${E}`),n&&f.push(`--entry-names=${n}`),a&&f.push(`--chunk-names=${a}`),x&&f.push(`--asset-names=${x}`),s&&f.push(`--main-fields=${pe(s,"main field")}`),c&&f.push(`--conditions=${pe(c,"condition")}`),h)for(let A of h)f.push(`--external:${Y(A,"external")}`);if(S)for(let A in S){if(A.indexOf("=")>=0)throw new Error(`Invalid package name in alias: ${A}`);f.push(`--alias:${A}=${Y(S[A],"alias",A)}`)}if(D)for(let A in D){if(A.indexOf("=")>=0)throw new Error(`Invalid banner file type: ${A}`);f.push(`--banner:${A}=${Y(D[A],"banner",A)}`)}if(B)for(let A in B){if(A.indexOf("=")>=0)throw new Error(`Invalid footer file type: ${A}`);f.push(`--footer:${A}=${Y(B[A],"footer",A)}`)}if(b)for(let A of b)f.push(`--inject:${Y(A,"inject")}`);if(u)for(let A in u){if(A.indexOf("=")>=0)throw new Error(`Invalid loader extension: ${A}`);f.push(`--loader:${A}=${Y(u[A],"loader",A)}`)}if(p)for(let A in p){if(A.indexOf("=")>=0)throw new Error(`Invalid out extension: ${A}`);f.push(`--out-extension:${A}=${Y(p[A],"out extension",A)}`)}if($)if(Array.isArray($))for(let A=0,le=$.length;A<le;A++){let K=$[A];if(typeof K=="object"&&K!==null){let te=Object.create(null),oe=i(K,te,"in",C),Z=i(K,te,"out",C);if(z(K,te,"in entry point at index "+A),oe===void 0)throw new Error('Missing property "in" for entry point at index '+A);if(Z===void 0)throw new Error('Missing property "out" for entry point at index '+A);v.push([Z,oe])}else v.push(["",Y(K,"entry point at index "+A)])}else for(let A in $)v.push([A,Y($[A],"entry point",A)]);if(N){let A=Object.create(null),le=i(N,A,"contents",Je),K=i(N,A,"resolveDir",C),te=i(N,A,"sourcefile",C),oe=i(N,A,"loader",C);z(N,A,'in "stdin" object'),te&&f.push(`--sourcefile=${te}`),oe&&f.push(`--loader=${oe}`),K&&(k=K),typeof le=="string"?y=ee(le):le instanceof Uint8Array&&(y=le)}let ie=[];if(d)for(let A of d)A+="",ie.push(A);return{entries:v,flags:f,write:U,stdinContents:y,stdinResolveDir:k,absWorkingDir:V,nodePaths:ie,mangleCache:qe(G)}}function dt(e,t,r,o){let m=[],g=Object.create(null);je(m,t,g,r,o),Ye(m,t,g);let f=i(t,g,"sourcemap",ze),v=i(t,g,"sourcefile",C),l=i(t,g,"loader",C),y=i(t,g,"banner",C),k=i(t,g,"footer",C),T=i(t,g,"mangleCache",Q);return z(t,g,`in ${e}() call`),f&&m.push(`--sourcemap=${f===!0?"external":f}`),v&&m.push(`--sourcefile=${v}`),l&&m.push(`--loader=${l}`),y&&m.push(`--banner=${y}`),k&&m.push(`--footer=${k}`),{flags:m,mangleCache:qe(T)}}function ht(e){const t={},r={didClose:!1,reason:""};let o={},m=0,g=0,f=new Uint8Array(16*1024),v=0,l=j=>{let w=v+j.length;if(w>f.length){let s=new Uint8Array(w*2);s.set(f),f=s}f.set(j,v),v+=j.length;let d=0;for(;d+4<=v;){let s=Fe(f,d);if(d+4+s>v)break;d+=4,M(f.subarray(d,d+s)),d+=s}d>0&&(f.copyWithin(0,d,v),v-=d)},y=j=>{r.didClose=!0,j&&(r.reason=": "+(j.message||j));const w="The service was stopped"+r.reason;for(let d in o)o[d](w,null);o={}},k=(j,w,d)=>{if(r.didClose)return d("The service is no longer running"+r.reason,null);let s=m++;o[s]=(c,h)=>{try{d(c,h)}finally{j&&j.unref()}},j&&j.ref(),e.writeToStdin(Ne({id:s,isRequest:!0,value:w}))},T=(j,w)=>{if(r.didClose)throw new Error("The service is no longer running"+r.reason);e.writeToStdin(Ne({id:j,isRequest:!1,value:w}))},I=(j,w)=>ae(null,null,function*(){try{if(w.command==="ping"){T(j,{});return}if(typeof w.key=="number"){const d=t[w.key];if(!d)return;const s=d[w.command];if(s){yield s(j,w);return}}throw new Error("Invalid command: "+w.command)}catch(d){const s=[me(d,e,null,void 0,"")];try{T(j,{errors:s})}catch(c){}}}),R=!0,M=j=>{if(R){R=!1;let d=String.fromCharCode(...j);if(d!=="0.27.7")throw new Error(`Cannot start service: Host version "0.27.7" does not match binary version ${J(d)}`);return}let w=rt(j);if(w.isRequest)I(w.id,w.value);else{let d=o[w.id];delete o[w.id],w.value.error?d(w.value.error,{}):d(null,w.value)}};return{readFromStdout:l,afterClose:y,service:{buildOrContext:({callName:j,refs:w,options:d,isTTY:s,defaultWD:c,callback:h})=>{let _=0;const S=g++,u={},p={ref(){++_===1&&w&&w.ref()},unref(){--_===0&&(delete t[S],w&&w.unref())}};t[S]=u,p.ref(),mt(j,S,k,T,p,e,u,d,s,c,(E,n)=>{try{h(E,n)}finally{p.unref()}})},transform:({callName:j,refs:w,input:d,options:s,isTTY:c,fs:h,callback:_})=>{const S=He();let u=p=>{try{if(typeof d!="string"&&!(d instanceof Uint8Array))throw new Error('The input to "transform" must be a string or a Uint8Array');let{flags:E,mangleCache:n}=dt(j,s,c,Be),a={command:"transform",flags:E,inputFS:p!==null,input:p!==null?ee(p):typeof d=="string"?ee(d):d};n&&(a.mangleCache=n),k(w,a,(x,b)=>{if(x)return _(new Error(x),null);let D=we(b.errors,S),B=we(b.warnings,S),$=1,V=()=>{if(--$===0){let N={warnings:B,code:b.code,map:b.map,mangleCache:void 0,legalComments:void 0};"legalComments"in b&&(N.legalComments=b==null?void 0:b.legalComments),b.mangleCache&&(N.mangleCache=b==null?void 0:b.mangleCache),_(null,N)}};if(D.length>0)return _(xe("Transform failed",D,B),null);b.codeFS&&($++,h.readFile(b.code,(N,U)=>{N!==null?_(N,null):(b.code=U,V())})),b.mapFS&&($++,h.readFile(b.map,(N,U)=>{N!==null?_(N,null):(b.map=U,V())})),V()})}catch(E){let n=[];try{je(n,s,{},c,Be)}catch(x){}const a=me(E,e,S,void 0,"");k(w,{command:"error",flags:n,error:a},()=>{a.detail=S.load(a.detail),_(xe("Transform failed",[a],[]),null)})}};if((typeof d=="string"||d instanceof Uint8Array)&&d.length>1024*1024){let p=u;u=()=>h.writeFile(d,p)}u(null)},formatMessages:({callName:j,refs:w,messages:d,options:s,callback:c})=>{if(!s)throw new Error(`Missing second argument in ${j}() call`);let h={},_=i(s,h,"kind",C),S=i(s,h,"color",L),u=i(s,h,"terminalWidth",he);if(z(s,h,`in ${j}() call`),_===void 0)throw new Error(`Missing "kind" in ${j}() call`);if(_!=="error"&&_!=="warning")throw new Error(`Expected "kind" to be "error" or "warning" in ${j}() call`);let p={command:"format-msgs",messages:se(d,"messages",null,"",u),isWarning:_==="warning"};S!==void 0&&(p.color=S),u!==void 0&&(p.terminalWidth=u),k(w,p,(E,n)=>{if(E)return c(new Error(E),null);c(null,n.messages)})},analyzeMetafile:({callName:j,refs:w,metafile:d,options:s,callback:c})=>{s===void 0&&(s={});let h={},_=i(s,h,"color",L),S=i(s,h,"verbose",L);z(s,h,`in ${j}() call`);let u={command:"analyze-metafile",metafile:d};_!==void 0&&(u.color=_),S!==void 0&&(u.verbose=S),k(w,u,(p,E)=>{if(p)return c(new Error(p),null);c(null,E.result)})}}}}function mt(e,t,r,o,m,g,f,v,l,y,k){const T=He(),I=e==="context",R=(O,W)=>{const P=[];try{je(P,v,{},l,Ve)}catch(w){}const j=me(O,g,T,void 0,W);r(m,{command:"error",flags:P,error:j},()=>{j.detail=T.load(j.detail),k(xe(I?"Context failed":"Build failed",[j],[]),null)})};let M;if(typeof v=="object"){const O=v.plugins;if(O!==void 0){if(!Array.isArray(O))return R(new Error('"plugins" must be an array'),"");M=O}}if(M&&M.length>0){if(g.isSync)return R(new Error("Cannot use plugins in synchronous API calls"),"");gt(t,r,o,m,g,f,v,M,T).then(O=>{if(!O.ok)return R(O.error,O.pluginName);try{F(O.requestPlugins,O.runOnEndCallbacks,O.scheduleOnDisposeCallbacks)}catch(W){R(W,"")}},O=>R(O,""));return}try{F(null,(O,W)=>W([],[]),()=>{})}catch(O){R(O,"")}function F(O,W,P){const j=g.hasFS,{entries:w,flags:d,write:s,stdinContents:c,stdinResolveDir:h,absWorkingDir:_,nodePaths:S,mangleCache:u}=ft(e,v,l,Ve,j);if(s&&!g.hasFS)throw new Error('The "write" option is unavailable in this environment');const p={command:"build",key:t,entries:w,flags:d,write:s,stdinContents:c,stdinResolveDir:h,absWorkingDir:_||y,nodePaths:S,context:I};O&&(p.plugins=O),u&&(p.mangleCache=u);const E=(x,b)=>{const D={errors:we(x.errors,T),warnings:we(x.warnings,T),outputFiles:void 0,metafile:void 0,mangleCache:void 0},B=D.errors.slice(),$=D.warnings.slice();x.outputFiles&&(D.outputFiles=x.outputFiles.map(wt)),x.metafile&&x.metafile.length&&(D.metafile=yt(x.metafile)),x.mangleCache&&(D.mangleCache=x.mangleCache),x.writeToStdout!==void 0&&console.log(de(x.writeToStdout).replace(/\n$/,"")),W(D,(V,N)=>{if(B.length>0||V.length>0){const U=xe("Build failed",B.concat(V),$.concat(N));return b(U,null,V,N)}b(null,D,V,N)})};let n,a;I&&(f["on-end"]=(x,b)=>new Promise(D=>{E(b,(B,$,V,N)=>{const U={errors:V,warnings:N};a&&a(B,$),n=void 0,a=void 0,o(x,U),D()})})),r(m,p,(x,b)=>{if(x)return k(new Error(x),null);if(!I)return E(b,($,V)=>(P(),k($,V)));if(b.errors.length>0)return k(xe("Context failed",b.errors,b.warnings),null);let D=!1;const B={rebuild:()=>(n||(n=new Promise(($,V)=>{let N;a=(H,G)=>{N||(N=()=>H?V(H):$(G))};const U=()=>{r(m,{command:"rebuild",key:t},(G,ie)=>{G?V(new Error(G)):N?N():U()})};U()})),n),watch:($={})=>new Promise((V,N)=>{if(!g.hasFS)throw new Error('Cannot use the "watch" API in this environment');const U={},H=i($,U,"delay",he);z($,U,"in watch() call");const G={command:"watch",key:t};H&&(G.delay=H),r(m,G,ie=>{ie?N(new Error(ie)):V(void 0)})}),serve:($={})=>new Promise((V,N)=>{if(!g.hasFS)throw new Error('Cannot use the "serve" API in this environment');const U={},H=i($,U,"port",it),G=i($,U,"host",C),ie=i($,U,"servedir",C),A=i($,U,"keyfile",C),le=i($,U,"certfile",C),K=i($,U,"fallback",C),te=i($,U,"cors",Q),oe=i($,U,"onRequest",Le);z($,U,"in serve() call");const Z={command:"serve",key:t,onRequest:!!oe};if(H!==void 0&&(Z.port=H),G!==void 0&&(Z.host=G),ie!==void 0&&(Z.servedir=ie),A!==void 0&&(Z.keyfile=A),le!==void 0&&(Z.certfile=le),K!==void 0&&(Z.fallback=K),te){const _e={},ye=i(te,_e,"origin",Ge);z(te,_e,'on "cors" object'),Array.isArray(ye)?Z.corsOrigin=ye:ye!==void 0&&(Z.corsOrigin=[ye])}r(m,Z,(_e,ye)=>{if(_e)return N(new Error(_e));oe&&(f["serve-request"]=(Dt,Rt)=>{oe(Rt.args),o(Dt,{})}),V(ye)})}),cancel:()=>new Promise($=>{if(D)return $();r(m,{command:"cancel",key:t},()=>{$()})}),dispose:()=>new Promise($=>{if(D)return $();D=!0,r(m,{command:"dispose",key:t},()=>{$(),P(),m.unref()})})};m.ref(),k(null,B)})}}var gt=(e,t,r,o,m,g,f,v,l)=>ae(null,null,function*(){let y=[],k=[],T={},I={},R=[],M=0,F=0,O=[],W=!1;v=[...v];for(let w of v){let d={};if(typeof w!="object")throw new Error(`Plugin at index ${F} must be an object`);const s=i(w,d,"name",C);if(typeof s!="string"||s==="")throw new Error(`Plugin at index ${F} is missing a name`);try{let c=i(w,d,"setup",Le);if(typeof c!="function")throw new Error("Plugin is missing a setup function");z(w,d,`on plugin ${J(s)}`);let h={name:s,onStart:!1,onEnd:!1,onResolve:[],onLoad:[]};F++;let S=c({initialOptions:f,resolve:(u,p={})=>{if(!W)throw new Error('Cannot call "resolve" before plugin setup has completed');if(typeof u!="string")throw new Error("The path to resolve must be a string");let E=Object.create(null),n=i(p,E,"pluginName",C),a=i(p,E,"importer",C),x=i(p,E,"namespace",C),b=i(p,E,"resolveDir",C),D=i(p,E,"kind",C),B=i(p,E,"pluginData",$e),$=i(p,E,"with",Q);return z(p,E,"in resolve() call"),new Promise((V,N)=>{const U={command:"resolve",path:u,key:e,pluginName:s};if(n!=null&&(U.pluginName=n),a!=null&&(U.importer=a),x!=null&&(U.namespace=x),b!=null&&(U.resolveDir=b),D!=null)U.kind=D;else throw new Error('Must specify "kind" when calling "resolve"');B!=null&&(U.pluginData=l.store(B)),$!=null&&(U.with=pt($,"with")),t(o,U,(H,G)=>{H!==null?N(new Error(H)):V({errors:we(G.errors,l),warnings:we(G.warnings,l),path:G.path,external:G.external,sideEffects:G.sideEffects,namespace:G.namespace,suffix:G.suffix,pluginData:l.load(G.pluginData)})})})},onStart(u){let p='This error came from the "onStart" callback registered here:',E=Pe(new Error(p),m,"onStart");y.push({name:s,callback:u,note:E}),h.onStart=!0},onEnd(u){let p='This error came from the "onEnd" callback registered here:',E=Pe(new Error(p),m,"onEnd");k.push({name:s,callback:u,note:E}),h.onEnd=!0},onResolve(u,p){let E='This error came from the "onResolve" callback registered here:',n=Pe(new Error(E),m,"onResolve"),a={},x=i(u,a,"filter",Te),b=i(u,a,"namespace",C);if(z(u,a,`in onResolve() call for plugin ${J(s)}`),x==null)throw new Error("onResolve() call is missing a filter");let D=M++;T[D]={name:s,callback:p,note:n},h.onResolve.push({id:D,filter:Ce(x),namespace:b||""})},onLoad(u,p){let E='This error came from the "onLoad" callback registered here:',n=Pe(new Error(E),m,"onLoad"),a={},x=i(u,a,"filter",Te),b=i(u,a,"namespace",C);if(z(u,a,`in onLoad() call for plugin ${J(s)}`),x==null)throw new Error("onLoad() call is missing a filter");let D=M++;I[D]={name:s,callback:p,note:n},h.onLoad.push({id:D,filter:Ce(x),namespace:b||""})},onDispose(u){R.push(u)},esbuild:m.esbuild});S&&(yield S),O.push(h)}catch(c){return{ok:!1,error:c,pluginName:s}}}g["on-start"]=(w,d)=>ae(null,null,function*(){l.clear();let s={errors:[],warnings:[]};yield Promise.all(y.map(c=>ae(null,[c],function*({name:h,callback:_,note:S}){try{let u=yield _();if(u!=null){if(typeof u!="object")throw new Error(`Expected onStart() callback in plugin ${J(h)} to return an object`);let p={},E=i(u,p,"errors",re),n=i(u,p,"warnings",re);z(u,p,`from onStart() callback in plugin ${J(h)}`),E!=null&&s.errors.push(...se(E,"errors",l,h,void 0)),n!=null&&s.warnings.push(...se(n,"warnings",l,h,void 0))}}catch(u){s.errors.push(me(u,m,l,S&&S(),h))}}))),r(w,s)}),g["on-resolve"]=(w,d)=>ae(null,null,function*(){let s={},c="",h,_;for(let S of d.ids)try{({name:c,callback:h,note:_}=T[S]);let u=yield h({path:d.path,importer:d.importer,namespace:d.namespace,resolveDir:d.resolveDir,kind:d.kind,pluginData:l.load(d.pluginData),with:d.with});if(u!=null){if(typeof u!="object")throw new Error(`Expected onResolve() callback in plugin ${J(c)} to return an object`);let p={},E=i(u,p,"pluginName",C),n=i(u,p,"path",C),a=i(u,p,"namespace",C),x=i(u,p,"suffix",C),b=i(u,p,"external",L),D=i(u,p,"sideEffects",L),B=i(u,p,"pluginData",$e),$=i(u,p,"errors",re),V=i(u,p,"warnings",re),N=i(u,p,"watchFiles",q),U=i(u,p,"watchDirs",q);z(u,p,`from onResolve() callback in plugin ${J(c)}`),s.id=S,E!=null&&(s.pluginName=E),n!=null&&(s.path=n),a!=null&&(s.namespace=a),x!=null&&(s.suffix=x),b!=null&&(s.external=b),D!=null&&(s.sideEffects=D),B!=null&&(s.pluginData=l.store(B)),$!=null&&(s.errors=se($,"errors",l,c,void 0)),V!=null&&(s.warnings=se(V,"warnings",l,c,void 0)),N!=null&&(s.watchFiles=Oe(N,"watchFiles")),U!=null&&(s.watchDirs=Oe(U,"watchDirs"));break}}catch(u){s={id:S,errors:[me(u,m,l,_&&_(),c)]};break}r(w,s)}),g["on-load"]=(w,d)=>ae(null,null,function*(){let s={},c="",h,_;for(let S of d.ids)try{({name:c,callback:h,note:_}=I[S]);let u=yield h({path:d.path,namespace:d.namespace,suffix:d.suffix,pluginData:l.load(d.pluginData),with:d.with});if(u!=null){if(typeof u!="object")throw new Error(`Expected onLoad() callback in plugin ${J(c)} to return an object`);let p={},E=i(u,p,"pluginName",C),n=i(u,p,"contents",Je),a=i(u,p,"resolveDir",C),x=i(u,p,"pluginData",$e),b=i(u,p,"loader",C),D=i(u,p,"errors",re),B=i(u,p,"warnings",re),$=i(u,p,"watchFiles",q),V=i(u,p,"watchDirs",q);z(u,p,`from onLoad() callback in plugin ${J(c)}`),s.id=S,E!=null&&(s.pluginName=E),n instanceof Uint8Array?s.contents=n:n!=null&&(s.contents=ee(n)),a!=null&&(s.resolveDir=a),x!=null&&(s.pluginData=l.store(x)),b!=null&&(s.loader=b),D!=null&&(s.errors=se(D,"errors",l,c,void 0)),B!=null&&(s.warnings=se(B,"warnings",l,c,void 0)),$!=null&&(s.watchFiles=Oe($,"watchFiles")),V!=null&&(s.watchDirs=Oe(V,"watchDirs"));break}}catch(u){s={id:S,errors:[me(u,m,l,_&&_(),c)]};break}r(w,s)});let P=(w,d)=>d([],[]);k.length>0&&(P=(w,d)=>{ae(null,null,function*(){const s=[],c=[];for(const{name:h,callback:_,note:S}of k){let u,p;try{const E=yield _(w);if(E!=null){if(typeof E!="object")throw new Error(`Expected onEnd() callback in plugin ${J(h)} to return an object`);let n={},a=i(E,n,"errors",re),x=i(E,n,"warnings",re);z(E,n,`from onEnd() callback in plugin ${J(h)}`),a!=null&&(u=se(a,"errors",l,h,void 0)),x!=null&&(p=se(x,"warnings",l,h,void 0))}}catch(E){u=[me(E,m,l,S&&S(),h)]}if(u){s.push(...u);try{w.errors.push(...u)}catch(E){}}if(p){c.push(...p);try{w.warnings.push(...p)}catch(E){}}}d(s,c)})});let j=()=>{for(const w of R)setTimeout(()=>w(),0)};return W=!0,{ok:!0,requestPlugins:O,runOnEndCallbacks:P,scheduleOnDisposeCallbacks:j}});function He(){const e=new Map;let t=0;return{clear(){e.clear()},load(r){return e.get(r)},store(r){if(r===void 0)return-1;const o=t++;return e.set(o,r),o}}}function Pe(e,t,r){let o,m=!1;return()=>{if(m)return o;m=!0;try{let g=(e.stack+"").split(`
`);g.splice(1,1);let f=Qe(t,g,r);if(f)return o={text:e.message,location:f},o}catch(g){}}}function me(e,t,r,o,m){let g="Internal error",f=null;try{g=(e&&e.message||e)+""}catch(v){}try{f=Qe(t,(e.stack+"").split(`
`),"")}catch(v){}return{id:"",pluginName:m,text:g,location:f,notes:o?[o]:[],detail:r?r.store(e):-1}}function Qe(e,t,r){let o="    at ";if(e.readFileSync&&!t[0].startsWith(o)&&t[1].startsWith(o))for(let m=1;m<t.length;m++){let g=t[m];if(g.startsWith(o))for(g=g.slice(o.length);;){let f=/^(?:new |async )?\S+ \((.*)\)$/.exec(g);if(f){g=f[1];continue}if(f=/^eval at \S+ \((.*)\)(?:, \S+:\d+:\d+)?$/.exec(g),f){g=f[1];continue}if(f=/^(\S+):(\d+):(\d+)$/.exec(g),f){let v;try{v=e.readFileSync(f[1],"utf8")}catch(T){break}let l=v.split(/\r\n|\r|\n|\u2028|\u2029/)[+f[2]-1]||"",y=+f[3]-1,k=l.slice(y,y+r.length)===r?r.length:0;return{file:f[1],namespace:"file",line:+f[2],column:ee(l.slice(0,y)).length,length:ee(l.slice(y,y+k)).length,lineText:l+`
`+t.slice(1).join(`
`),suggestion:""}}break}}return null}function xe(e,t,r){let o=5;e+=t.length<1?"":` with ${t.length} error${t.length<2?"":"s"}:`+t.slice(0,o+1).map((g,f)=>{if(f===o)return`
...`;if(!g.location)return`
error: ${g.text}`;let{file:v,line:l,column:y}=g.location,k=g.pluginName?`[plugin: ${g.pluginName}] `:"";return`
${v}:${l}:${y}: ERROR: ${k}${g.text}`}).join("");let m=new Error(e);for(const[g,f]of[["errors",t],["warnings",r]])Object.defineProperty(m,g,{configurable:!0,enumerable:!0,get:()=>f,set:v=>Object.defineProperty(m,g,{configurable:!0,enumerable:!0,value:v})});return m}function we(e,t){for(const r of e)r.detail=t.load(r.detail);return e}function Xe(e,t,r){if(e==null)return null;let o={},m=i(e,o,"file",C),g=i(e,o,"namespace",C),f=i(e,o,"line",he),v=i(e,o,"column",he),l=i(e,o,"length",he),y=i(e,o,"lineText",C),k=i(e,o,"suggestion",C);if(z(e,o,t),y){const T=y.slice(0,(v&&v>0?v:0)+(l&&l>0?l:0)+(r&&r>0?r:80));!/[\x7F-\uFFFF]/.test(T)&&!/\n/.test(y)&&(y=T)}return{file:m||"",namespace:g||"",line:f||0,column:v||0,length:l||0,lineText:y||"",suggestion:k||""}}function se(e,t,r,o,m){let g=[],f=0;for(const v of e){let l={},y=i(v,l,"id",C),k=i(v,l,"pluginName",C),T=i(v,l,"text",C),I=i(v,l,"location",We),R=i(v,l,"notes",re),M=i(v,l,"detail",$e),F=`in element ${f} of "${t}"`;z(v,l,F);let O=[];if(R)for(const W of R){let P={},j=i(W,P,"text",C),w=i(W,P,"location",We);z(W,P,F),O.push({text:j||"",location:Xe(w,F,m)})}g.push({id:y||"",pluginName:k||o,text:T||"",location:Xe(I,F,m),notes:O,detail:r?r.store(M):-1}),f++}return g}function Oe(e,t){const r=[];for(const o of e){if(typeof o!="string")throw new Error(`${J(t)} must be an array of strings`);r.push(o)}return r}function pt(e,t){const r=Object.create(null);for(const o in e){const m=e[o];if(typeof m!="string")throw new Error(`key ${J(o)} in object ${J(t)} must be a string`);r[o]=m}return r}function wt({path:e,contents:t,hash:r}){let o=null;return{path:e,contents:t,hash:r,get text(){const m=this.contents;return(o===null||m!==t)&&(t=m,o=de(m)),o}}}function Ce(e){let t=e.source;return e.flags&&(t=`(?${e.flags})${t}`),t}function yt(e){let t;try{t=de(e)}catch(r){return st(e)}return JSON.parse(t)}var vt="0.27.7",bt=e=>ke().build(e),xt=e=>ke().context(e),kt=(e,t)=>ke().transform(e,t),_t=(e,t)=>ke().formatMessages(e,t),Et=(e,t)=>ke().analyzeMetafile(e,t),St=()=>{throw new Error('The "buildSync" API only works in node')},$t=()=>{throw new Error('The "transformSync" API only works in node')},Tt=()=>{throw new Error('The "formatMessagesSync" API only works in node')},jt=()=>{throw new Error('The "analyzeMetafileSync" API only works in node')},Pt=()=>(Ae&&Ae(),Promise.resolve()),ge,Ae,De,ke=()=>{if(De)return De;throw ge?new Error('You need to wait for the promise returned from "initialize" to be resolved before calling this'):new Error('You need to call "initialize" before calling this')},Ot=e=>{e=ut(e||{});let t=e.wasmURL,r=e.wasmModule,o=e.worker!==!1;if(!t&&!r)throw new Error('Must provide either the "wasmURL" option or the "wasmModule" option');if(ge)throw new Error('Cannot call "initialize" more than once');return ge=Ct(t||"",r,o),ge.catch(()=>{ge=void 0}),ge},Ct=(e,t,r)=>ae(null,null,function*(){let o,m;const g=new Promise(T=>m=T);if(r){let T=new Blob([`onmessage=((postMessage) => {
      // Copyright 2018 The Go Authors. All rights reserved.
      // Use of this source code is governed by a BSD-style
      // license that can be found in the LICENSE file.
      var __async = (__this, __arguments, generator) => {
        return new Promise((resolve, reject) => {
          var fulfilled = (value) => {
            try {
              step(generator.next(value));
            } catch (e) {
              reject(e);
            }
          };
          var rejected = (value) => {
            try {
              step(generator.throw(value));
            } catch (e) {
              reject(e);
            }
          };
          var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
          step((generator = generator.apply(__this, __arguments)).next());
        });
      };
      let onmessage;
      let globalThis = {};
      for (let o = self; o; o = Object.getPrototypeOf(o))
        for (let k of Object.getOwnPropertyNames(o))
          if (!(k in globalThis))
            Object.defineProperty(globalThis, k, { get: () => self[k] });
      "use strict";
      (() => {
        const enosys = () => {
          const err = new Error("not implemented");
          err.code = "ENOSYS";
          return err;
        };
        if (!globalThis.fs) {
          let outputBuf = "";
          globalThis.fs = {
            constants: { O_WRONLY: -1, O_RDWR: -1, O_CREAT: -1, O_TRUNC: -1, O_APPEND: -1, O_EXCL: -1, O_DIRECTORY: -1 },
            // unused
            writeSync(fd, buf) {
              outputBuf += decoder.decode(buf);
              const nl = outputBuf.lastIndexOf("\\n");
              if (nl != -1) {
                console.log(outputBuf.substring(0, nl));
                outputBuf = outputBuf.substring(nl + 1);
              }
              return buf.length;
            },
            write(fd, buf, offset, length, position, callback) {
              if (offset !== 0 || length !== buf.length || position !== null) {
                callback(enosys());
                return;
              }
              const n = this.writeSync(fd, buf);
              callback(null, n);
            },
            chmod(path, mode, callback) {
              callback(enosys());
            },
            chown(path, uid, gid, callback) {
              callback(enosys());
            },
            close(fd, callback) {
              callback(enosys());
            },
            fchmod(fd, mode, callback) {
              callback(enosys());
            },
            fchown(fd, uid, gid, callback) {
              callback(enosys());
            },
            fstat(fd, callback) {
              callback(enosys());
            },
            fsync(fd, callback) {
              callback(null);
            },
            ftruncate(fd, length, callback) {
              callback(enosys());
            },
            lchown(path, uid, gid, callback) {
              callback(enosys());
            },
            link(path, link, callback) {
              callback(enosys());
            },
            lstat(path, callback) {
              callback(enosys());
            },
            mkdir(path, perm, callback) {
              callback(enosys());
            },
            open(path, flags, mode, callback) {
              callback(enosys());
            },
            read(fd, buffer, offset, length, position, callback) {
              callback(enosys());
            },
            readdir(path, callback) {
              callback(enosys());
            },
            readlink(path, callback) {
              callback(enosys());
            },
            rename(from, to, callback) {
              callback(enosys());
            },
            rmdir(path, callback) {
              callback(enosys());
            },
            stat(path, callback) {
              callback(enosys());
            },
            symlink(path, link, callback) {
              callback(enosys());
            },
            truncate(path, length, callback) {
              callback(enosys());
            },
            unlink(path, callback) {
              callback(enosys());
            },
            utimes(path, atime, mtime, callback) {
              callback(enosys());
            }
          };
        }
        if (!globalThis.process) {
          globalThis.process = {
            getuid() {
              return -1;
            },
            getgid() {
              return -1;
            },
            geteuid() {
              return -1;
            },
            getegid() {
              return -1;
            },
            getgroups() {
              throw enosys();
            },
            pid: -1,
            ppid: -1,
            umask() {
              throw enosys();
            },
            cwd() {
              throw enosys();
            },
            chdir() {
              throw enosys();
            }
          };
        }
        if (!globalThis.path) {
          globalThis.path = {
            resolve(...pathSegments) {
              return pathSegments.join("/");
            }
          };
        }
        if (!globalThis.crypto) {
          throw new Error("globalThis.crypto is not available, polyfill required (crypto.getRandomValues only)");
        }
        if (!globalThis.performance) {
          throw new Error("globalThis.performance is not available, polyfill required (performance.now only)");
        }
        if (!globalThis.TextEncoder) {
          throw new Error("globalThis.TextEncoder is not available, polyfill required");
        }
        if (!globalThis.TextDecoder) {
          throw new Error("globalThis.TextDecoder is not available, polyfill required");
        }
        const encoder = new TextEncoder("utf-8");
        const decoder = new TextDecoder("utf-8");
        globalThis.Go = class {
          constructor() {
            this.argv = ["js"];
            this.env = {};
            this.exit = (code) => {
              if (code !== 0) {
                console.warn("exit code:", code);
              }
            };
            this._exitPromise = new Promise((resolve) => {
              this._resolveExitPromise = resolve;
            });
            this._pendingEvent = null;
            this._scheduledTimeouts = /* @__PURE__ */ new Map();
            this._nextCallbackTimeoutID = 1;
            const setInt64 = (addr, v) => {
              this.mem.setUint32(addr + 0, v, true);
              this.mem.setUint32(addr + 4, Math.floor(v / 4294967296), true);
            };
            const setInt32 = (addr, v) => {
              this.mem.setUint32(addr + 0, v, true);
            };
            const getInt64 = (addr) => {
              const low = this.mem.getUint32(addr + 0, true);
              const high = this.mem.getInt32(addr + 4, true);
              return low + high * 4294967296;
            };
            const loadValue = (addr) => {
              const f = this.mem.getFloat64(addr, true);
              if (f === 0) {
                return void 0;
              }
              if (!isNaN(f)) {
                return f;
              }
              const id = this.mem.getUint32(addr, true);
              return this._values[id];
            };
            const storeValue = (addr, v) => {
              const nanHead = 2146959360;
              if (typeof v === "number" && v !== 0) {
                if (isNaN(v)) {
                  this.mem.setUint32(addr + 4, nanHead, true);
                  this.mem.setUint32(addr, 0, true);
                  return;
                }
                this.mem.setFloat64(addr, v, true);
                return;
              }
              if (v === void 0) {
                this.mem.setFloat64(addr, 0, true);
                return;
              }
              let id = this._ids.get(v);
              if (id === void 0) {
                id = this._idPool.pop();
                if (id === void 0) {
                  id = this._values.length;
                }
                this._values[id] = v;
                this._goRefCounts[id] = 0;
                this._ids.set(v, id);
              }
              this._goRefCounts[id]++;
              let typeFlag = 0;
              switch (typeof v) {
                case "object":
                  if (v !== null) {
                    typeFlag = 1;
                  }
                  break;
                case "string":
                  typeFlag = 2;
                  break;
                case "symbol":
                  typeFlag = 3;
                  break;
                case "function":
                  typeFlag = 4;
                  break;
              }
              this.mem.setUint32(addr + 4, nanHead | typeFlag, true);
              this.mem.setUint32(addr, id, true);
            };
            const loadSlice = (addr) => {
              const array = getInt64(addr + 0);
              const len = getInt64(addr + 8);
              return new Uint8Array(this._inst.exports.mem.buffer, array, len);
            };
            const loadSliceOfValues = (addr) => {
              const array = getInt64(addr + 0);
              const len = getInt64(addr + 8);
              const a = new Array(len);
              for (let i = 0; i < len; i++) {
                a[i] = loadValue(array + i * 8);
              }
              return a;
            };
            const loadString = (addr) => {
              const saddr = getInt64(addr + 0);
              const len = getInt64(addr + 8);
              return decoder.decode(new DataView(this._inst.exports.mem.buffer, saddr, len));
            };
            const testCallExport = (a, b) => {
              this._inst.exports.testExport0();
              return this._inst.exports.testExport(a, b);
            };
            const timeOrigin = Date.now() - performance.now();
            this.importObject = {
              _gotest: {
                add: (a, b) => a + b,
                callExport: testCallExport
              },
              gojs: {
                // Go's SP does not change as long as no Go code is running. Some operations (e.g. calls, getters and setters)
                // may synchronously trigger a Go event handler. This makes Go code get executed in the middle of the imported
                // function. A goroutine can switch to a new stack if the current stack is too small (see morestack function).
                // This changes the SP, thus we have to update the SP used by the imported function.
                // func wasmExit(code int32)
                "runtime.wasmExit": (sp) => {
                  sp >>>= 0;
                  const code = this.mem.getInt32(sp + 8, true);
                  this.exited = true;
                  delete this._inst;
                  delete this._values;
                  delete this._goRefCounts;
                  delete this._ids;
                  delete this._idPool;
                  this.exit(code);
                },
                // func wasmWrite(fd uintptr, p unsafe.Pointer, n int32)
                "runtime.wasmWrite": (sp) => {
                  sp >>>= 0;
                  const fd = getInt64(sp + 8);
                  const p = getInt64(sp + 16);
                  const n = this.mem.getInt32(sp + 24, true);
                  globalThis.fs.writeSync(fd, new Uint8Array(this._inst.exports.mem.buffer, p, n));
                },
                // func resetMemoryDataView()
                "runtime.resetMemoryDataView": (sp) => {
                  sp >>>= 0;
                  this.mem = new DataView(this._inst.exports.mem.buffer);
                },
                // func nanotime1() int64
                "runtime.nanotime1": (sp) => {
                  sp >>>= 0;
                  setInt64(sp + 8, (timeOrigin + performance.now()) * 1e6);
                },
                // func walltime() (sec int64, nsec int32)
                "runtime.walltime": (sp) => {
                  sp >>>= 0;
                  const msec = (/* @__PURE__ */ new Date()).getTime();
                  setInt64(sp + 8, msec / 1e3);
                  this.mem.setInt32(sp + 16, msec % 1e3 * 1e6, true);
                },
                // func scheduleTimeoutEvent(delay int64) int32
                "runtime.scheduleTimeoutEvent": (sp) => {
                  sp >>>= 0;
                  const id = this._nextCallbackTimeoutID;
                  this._nextCallbackTimeoutID++;
                  this._scheduledTimeouts.set(id, setTimeout(
                    () => {
                      this._resume();
                      while (this._scheduledTimeouts.has(id)) {
                        console.warn("scheduleTimeoutEvent: missed timeout event");
                        this._resume();
                      }
                    },
                    getInt64(sp + 8)
                  ));
                  this.mem.setInt32(sp + 16, id, true);
                },
                // func clearTimeoutEvent(id int32)
                "runtime.clearTimeoutEvent": (sp) => {
                  sp >>>= 0;
                  const id = this.mem.getInt32(sp + 8, true);
                  clearTimeout(this._scheduledTimeouts.get(id));
                  this._scheduledTimeouts.delete(id);
                },
                // func getRandomData(r []byte)
                "runtime.getRandomData": (sp) => {
                  sp >>>= 0;
                  crypto.getRandomValues(loadSlice(sp + 8));
                },
                // func finalizeRef(v ref)
                "syscall/js.finalizeRef": (sp) => {
                  sp >>>= 0;
                  const id = this.mem.getUint32(sp + 8, true);
                  this._goRefCounts[id]--;
                  if (this._goRefCounts[id] === 0) {
                    const v = this._values[id];
                    this._values[id] = null;
                    this._ids.delete(v);
                    this._idPool.push(id);
                  }
                },
                // func stringVal(value string) ref
                "syscall/js.stringVal": (sp) => {
                  sp >>>= 0;
                  storeValue(sp + 24, loadString(sp + 8));
                },
                // func valueGet(v ref, p string) ref
                "syscall/js.valueGet": (sp) => {
                  sp >>>= 0;
                  const result = Reflect.get(loadValue(sp + 8), loadString(sp + 16));
                  sp = this._inst.exports.getsp() >>> 0;
                  storeValue(sp + 32, result);
                },
                // func valueSet(v ref, p string, x ref)
                "syscall/js.valueSet": (sp) => {
                  sp >>>= 0;
                  Reflect.set(loadValue(sp + 8), loadString(sp + 16), loadValue(sp + 32));
                },
                // func valueDelete(v ref, p string)
                "syscall/js.valueDelete": (sp) => {
                  sp >>>= 0;
                  Reflect.deleteProperty(loadValue(sp + 8), loadString(sp + 16));
                },
                // func valueIndex(v ref, i int) ref
                "syscall/js.valueIndex": (sp) => {
                  sp >>>= 0;
                  storeValue(sp + 24, Reflect.get(loadValue(sp + 8), getInt64(sp + 16)));
                },
                // valueSetIndex(v ref, i int, x ref)
                "syscall/js.valueSetIndex": (sp) => {
                  sp >>>= 0;
                  Reflect.set(loadValue(sp + 8), getInt64(sp + 16), loadValue(sp + 24));
                },
                // func valueCall(v ref, m string, args []ref) (ref, bool)
                "syscall/js.valueCall": (sp) => {
                  sp >>>= 0;
                  try {
                    const v = loadValue(sp + 8);
                    const m = Reflect.get(v, loadString(sp + 16));
                    const args = loadSliceOfValues(sp + 32);
                    const result = Reflect.apply(m, v, args);
                    sp = this._inst.exports.getsp() >>> 0;
                    storeValue(sp + 56, result);
                    this.mem.setUint8(sp + 64, 1);
                  } catch (err) {
                    sp = this._inst.exports.getsp() >>> 0;
                    storeValue(sp + 56, err);
                    this.mem.setUint8(sp + 64, 0);
                  }
                },
                // func valueInvoke(v ref, args []ref) (ref, bool)
                "syscall/js.valueInvoke": (sp) => {
                  sp >>>= 0;
                  try {
                    const v = loadValue(sp + 8);
                    const args = loadSliceOfValues(sp + 16);
                    const result = Reflect.apply(v, void 0, args);
                    sp = this._inst.exports.getsp() >>> 0;
                    storeValue(sp + 40, result);
                    this.mem.setUint8(sp + 48, 1);
                  } catch (err) {
                    sp = this._inst.exports.getsp() >>> 0;
                    storeValue(sp + 40, err);
                    this.mem.setUint8(sp + 48, 0);
                  }
                },
                // func valueNew(v ref, args []ref) (ref, bool)
                "syscall/js.valueNew": (sp) => {
                  sp >>>= 0;
                  try {
                    const v = loadValue(sp + 8);
                    const args = loadSliceOfValues(sp + 16);
                    const result = Reflect.construct(v, args);
                    sp = this._inst.exports.getsp() >>> 0;
                    storeValue(sp + 40, result);
                    this.mem.setUint8(sp + 48, 1);
                  } catch (err) {
                    sp = this._inst.exports.getsp() >>> 0;
                    storeValue(sp + 40, err);
                    this.mem.setUint8(sp + 48, 0);
                  }
                },
                // func valueLength(v ref) int
                "syscall/js.valueLength": (sp) => {
                  sp >>>= 0;
                  setInt64(sp + 16, parseInt(loadValue(sp + 8).length));
                },
                // valuePrepareString(v ref) (ref, int)
                "syscall/js.valuePrepareString": (sp) => {
                  sp >>>= 0;
                  const str = encoder.encode(String(loadValue(sp + 8)));
                  storeValue(sp + 16, str);
                  setInt64(sp + 24, str.length);
                },
                // valueLoadString(v ref, b []byte)
                "syscall/js.valueLoadString": (sp) => {
                  sp >>>= 0;
                  const str = loadValue(sp + 8);
                  loadSlice(sp + 16).set(str);
                },
                // func valueInstanceOf(v ref, t ref) bool
                "syscall/js.valueInstanceOf": (sp) => {
                  sp >>>= 0;
                  this.mem.setUint8(sp + 24, loadValue(sp + 8) instanceof loadValue(sp + 16) ? 1 : 0);
                },
                // func copyBytesToGo(dst []byte, src ref) (int, bool)
                "syscall/js.copyBytesToGo": (sp) => {
                  sp >>>= 0;
                  const dst = loadSlice(sp + 8);
                  const src = loadValue(sp + 32);
                  if (!(src instanceof Uint8Array || src instanceof Uint8ClampedArray)) {
                    this.mem.setUint8(sp + 48, 0);
                    return;
                  }
                  const toCopy = src.subarray(0, dst.length);
                  dst.set(toCopy);
                  setInt64(sp + 40, toCopy.length);
                  this.mem.setUint8(sp + 48, 1);
                },
                // func copyBytesToJS(dst ref, src []byte) (int, bool)
                "syscall/js.copyBytesToJS": (sp) => {
                  sp >>>= 0;
                  const dst = loadValue(sp + 8);
                  const src = loadSlice(sp + 16);
                  if (!(dst instanceof Uint8Array || dst instanceof Uint8ClampedArray)) {
                    this.mem.setUint8(sp + 48, 0);
                    return;
                  }
                  const toCopy = src.subarray(0, dst.length);
                  dst.set(toCopy);
                  setInt64(sp + 40, toCopy.length);
                  this.mem.setUint8(sp + 48, 1);
                },
                "debug": (value) => {
                  console.log(value);
                }
              }
            };
          }
          run(instance) {
            return __async(this, null, function* () {
              if (!(instance instanceof WebAssembly.Instance)) {
                throw new Error("Go.run: WebAssembly.Instance expected");
              }
              this._inst = instance;
              this.mem = new DataView(this._inst.exports.mem.buffer);
              this._values = [
                // JS values that Go currently has references to, indexed by reference id
                NaN,
                0,
                null,
                true,
                false,
                globalThis,
                this
              ];
              this._goRefCounts = new Array(this._values.length).fill(Infinity);
              this._ids = /* @__PURE__ */ new Map([
                // mapping from JS values to reference ids
                [0, 1],
                [null, 2],
                [true, 3],
                [false, 4],
                [globalThis, 5],
                [this, 6]
              ]);
              this._idPool = [];
              this.exited = false;
              let offset = 4096;
              const strPtr = (str) => {
                const ptr = offset;
                const bytes = encoder.encode(str + "\\0");
                new Uint8Array(this.mem.buffer, offset, bytes.length).set(bytes);
                offset += bytes.length;
                if (offset % 8 !== 0) {
                  offset += 8 - offset % 8;
                }
                return ptr;
              };
              const argc = this.argv.length;
              const argvPtrs = [];
              this.argv.forEach((arg) => {
                argvPtrs.push(strPtr(arg));
              });
              argvPtrs.push(0);
              const keys = Object.keys(this.env).sort();
              keys.forEach((key) => {
                argvPtrs.push(strPtr(\`\${key}=\${this.env[key]}\`));
              });
              argvPtrs.push(0);
              const argv = offset;
              argvPtrs.forEach((ptr) => {
                this.mem.setUint32(offset, ptr, true);
                this.mem.setUint32(offset + 4, 0, true);
                offset += 8;
              });
              const wasmMinDataAddr = 4096 + 8192;
              if (offset >= wasmMinDataAddr) {
                throw new Error("total length of command line and environment variables exceeds limit");
              }
              this._inst.exports.run(argc, argv);
              if (this.exited) {
                this._resolveExitPromise();
              }
              yield this._exitPromise;
            });
          }
          _resume() {
            if (this.exited) {
              throw new Error("Go program has already exited");
            }
            this._inst.exports.resume();
            if (this.exited) {
              this._resolveExitPromise();
            }
          }
          _makeFuncWrapper(id) {
            const go = this;
            return function() {
              const event = { id, this: this, args: arguments };
              go._pendingEvent = event;
              go._resume();
              return event.result;
            };
          }
        };
      })();
      onmessage = ({ data: wasm }) => {
        let decoder = new TextDecoder();
        let fs = globalThis.fs;
        let stderr = "";
        fs.writeSync = (fd, buffer) => {
          if (fd === 1) {
            postMessage(buffer);
          } else if (fd === 2) {
            stderr += decoder.decode(buffer);
            let parts = stderr.split("\\n");
            if (parts.length > 1) console.log(parts.slice(0, -1).join("\\n"));
            stderr = parts[parts.length - 1];
          } else {
            throw new Error("Bad write");
          }
          return buffer.length;
        };
        let stdin = [];
        let resumeStdin;
        let stdinPos = 0;
        onmessage = ({ data }) => {
          if (data.length > 0) {
            stdin.push(data);
            if (resumeStdin) resumeStdin();
          }
          return go;
        };
        fs.read = (fd, buffer, offset, length, position, callback) => {
          if (fd !== 0 || offset !== 0 || length !== buffer.length || position !== null) {
            throw new Error("Bad read");
          }
          if (stdin.length === 0) {
            resumeStdin = () => fs.read(fd, buffer, offset, length, position, callback);
            return;
          }
          let first = stdin[0];
          let count = Math.max(0, Math.min(length, first.length - stdinPos));
          buffer.set(first.subarray(stdinPos, stdinPos + count), offset);
          stdinPos += count;
          if (stdinPos === first.length) {
            stdin.shift();
            stdinPos = 0;
          }
          callback(null, count);
        };
        let go = new globalThis.Go();
        go.argv = ["", \`--service=\${"0.27.7"}\`];
        tryToInstantiateModule(wasm, go).then(
          (instance) => {
            postMessage(null);
            go.run(instance);
          },
          (error) => {
            postMessage(error);
          }
        );
        return go;
      };
      function tryToInstantiateModule(wasm, go) {
        return __async(this, null, function* () {
          if (wasm instanceof WebAssembly.Module) {
            return WebAssembly.instantiate(wasm, go.importObject);
          }
          const res = yield fetch(wasm);
          if (!res.ok) throw new Error(\`Failed to download \${JSON.stringify(wasm)}\`);
          if ("instantiateStreaming" in WebAssembly && /^application\\/wasm($|;)/i.test(res.headers.get("Content-Type") || "")) {
            const result2 = yield WebAssembly.instantiateStreaming(res, go.importObject);
            return result2.instance;
          }
          const bytes = yield res.arrayBuffer();
          const result = yield WebAssembly.instantiate(bytes, go.importObject);
          return result.instance;
        });
      }
      return (m) => onmessage(m);
    })(postMessage)`],{type:"text/javascript"});o=new Worker(URL.createObjectURL(T))}else{let T=(R=>{var M=(P,j,w)=>new Promise((d,s)=>{var c=S=>{try{_(w.next(S))}catch(u){s(u)}},h=S=>{try{_(w.throw(S))}catch(u){s(u)}},_=S=>S.done?d(S.value):Promise.resolve(S.value).then(c,h);_((w=w.apply(P,j)).next())});let F,O={};for(let P=self;P;P=Object.getPrototypeOf(P))for(let j of Object.getOwnPropertyNames(P))j in O||Object.defineProperty(O,j,{get:()=>self[j]});(()=>{const P=()=>{const d=new Error("not implemented");return d.code="ENOSYS",d};if(!O.fs){let d="";O.fs={constants:{O_WRONLY:-1,O_RDWR:-1,O_CREAT:-1,O_TRUNC:-1,O_APPEND:-1,O_EXCL:-1,O_DIRECTORY:-1},writeSync(s,c){d+=w.decode(c);const h=d.lastIndexOf(`
`);return h!=-1&&(console.log(d.substring(0,h)),d=d.substring(h+1)),c.length},write(s,c,h,_,S,u){if(h!==0||_!==c.length||S!==null){u(P());return}const p=this.writeSync(s,c);u(null,p)},chmod(s,c,h){h(P())},chown(s,c,h,_){_(P())},close(s,c){c(P())},fchmod(s,c,h){h(P())},fchown(s,c,h,_){_(P())},fstat(s,c){c(P())},fsync(s,c){c(null)},ftruncate(s,c,h){h(P())},lchown(s,c,h,_){_(P())},link(s,c,h){h(P())},lstat(s,c){c(P())},mkdir(s,c,h){h(P())},open(s,c,h,_){_(P())},read(s,c,h,_,S,u){u(P())},readdir(s,c){c(P())},readlink(s,c){c(P())},rename(s,c,h){h(P())},rmdir(s,c){c(P())},stat(s,c){c(P())},symlink(s,c,h){h(P())},truncate(s,c,h){h(P())},unlink(s,c){c(P())},utimes(s,c,h,_){_(P())}}}if(O.process||(O.process={getuid(){return-1},getgid(){return-1},geteuid(){return-1},getegid(){return-1},getgroups(){throw P()},pid:-1,ppid:-1,umask(){throw P()},cwd(){throw P()},chdir(){throw P()}}),O.path||(O.path={resolve(...d){return d.join("/")}}),!O.crypto)throw new Error("globalThis.crypto is not available, polyfill required (crypto.getRandomValues only)");if(!O.performance)throw new Error("globalThis.performance is not available, polyfill required (performance.now only)");if(!O.TextEncoder)throw new Error("globalThis.TextEncoder is not available, polyfill required");if(!O.TextDecoder)throw new Error("globalThis.TextDecoder is not available, polyfill required");const j=new TextEncoder("utf-8"),w=new TextDecoder("utf-8");O.Go=class{constructor(){this.argv=["js"],this.env={},this.exit=n=>{n!==0&&console.warn("exit code:",n)},this._exitPromise=new Promise(n=>{this._resolveExitPromise=n}),this._pendingEvent=null,this._scheduledTimeouts=new Map,this._nextCallbackTimeoutID=1;const d=(n,a)=>{this.mem.setUint32(n+0,a,!0),this.mem.setUint32(n+4,Math.floor(a/4294967296),!0)},s=n=>{const a=this.mem.getUint32(n+0,!0),x=this.mem.getInt32(n+4,!0);return a+x*4294967296},c=n=>{const a=this.mem.getFloat64(n,!0);if(a===0)return;if(!isNaN(a))return a;const x=this.mem.getUint32(n,!0);return this._values[x]},h=(n,a)=>{if(typeof a=="number"&&a!==0){if(isNaN(a)){this.mem.setUint32(n+4,2146959360,!0),this.mem.setUint32(n,0,!0);return}this.mem.setFloat64(n,a,!0);return}if(a===void 0){this.mem.setFloat64(n,0,!0);return}let b=this._ids.get(a);b===void 0&&(b=this._idPool.pop(),b===void 0&&(b=this._values.length),this._values[b]=a,this._goRefCounts[b]=0,this._ids.set(a,b)),this._goRefCounts[b]++;let D=0;switch(typeof a){case"object":a!==null&&(D=1);break;case"string":D=2;break;case"symbol":D=3;break;case"function":D=4;break}this.mem.setUint32(n+4,2146959360|D,!0),this.mem.setUint32(n,b,!0)},_=n=>{const a=s(n+0),x=s(n+8);return new Uint8Array(this._inst.exports.mem.buffer,a,x)},S=n=>{const a=s(n+0),x=s(n+8),b=new Array(x);for(let D=0;D<x;D++)b[D]=c(a+D*8);return b},u=n=>{const a=s(n+0),x=s(n+8);return w.decode(new DataView(this._inst.exports.mem.buffer,a,x))},p=(n,a)=>(this._inst.exports.testExport0(),this._inst.exports.testExport(n,a)),E=Date.now()-performance.now();this.importObject={_gotest:{add:(n,a)=>n+a,callExport:p},gojs:{"runtime.wasmExit":n=>{n>>>=0;const a=this.mem.getInt32(n+8,!0);this.exited=!0,delete this._inst,delete this._values,delete this._goRefCounts,delete this._ids,delete this._idPool,this.exit(a)},"runtime.wasmWrite":n=>{n>>>=0;const a=s(n+8),x=s(n+16),b=this.mem.getInt32(n+24,!0);O.fs.writeSync(a,new Uint8Array(this._inst.exports.mem.buffer,x,b))},"runtime.resetMemoryDataView":n=>{this.mem=new DataView(this._inst.exports.mem.buffer)},"runtime.nanotime1":n=>{n>>>=0,d(n+8,(E+performance.now())*1e6)},"runtime.walltime":n=>{n>>>=0;const a=new Date().getTime();d(n+8,a/1e3),this.mem.setInt32(n+16,a%1e3*1e6,!0)},"runtime.scheduleTimeoutEvent":n=>{n>>>=0;const a=this._nextCallbackTimeoutID;this._nextCallbackTimeoutID++,this._scheduledTimeouts.set(a,setTimeout(()=>{for(this._resume();this._scheduledTimeouts.has(a);)console.warn("scheduleTimeoutEvent: missed timeout event"),this._resume()},s(n+8))),this.mem.setInt32(n+16,a,!0)},"runtime.clearTimeoutEvent":n=>{n>>>=0;const a=this.mem.getInt32(n+8,!0);clearTimeout(this._scheduledTimeouts.get(a)),this._scheduledTimeouts.delete(a)},"runtime.getRandomData":n=>{n>>>=0,crypto.getRandomValues(_(n+8))},"syscall/js.finalizeRef":n=>{n>>>=0;const a=this.mem.getUint32(n+8,!0);if(this._goRefCounts[a]--,this._goRefCounts[a]===0){const x=this._values[a];this._values[a]=null,this._ids.delete(x),this._idPool.push(a)}},"syscall/js.stringVal":n=>{n>>>=0,h(n+24,u(n+8))},"syscall/js.valueGet":n=>{n>>>=0;const a=Reflect.get(c(n+8),u(n+16));n=this._inst.exports.getsp()>>>0,h(n+32,a)},"syscall/js.valueSet":n=>{n>>>=0,Reflect.set(c(n+8),u(n+16),c(n+32))},"syscall/js.valueDelete":n=>{n>>>=0,Reflect.deleteProperty(c(n+8),u(n+16))},"syscall/js.valueIndex":n=>{n>>>=0,h(n+24,Reflect.get(c(n+8),s(n+16)))},"syscall/js.valueSetIndex":n=>{n>>>=0,Reflect.set(c(n+8),s(n+16),c(n+24))},"syscall/js.valueCall":n=>{n>>>=0;try{const a=c(n+8),x=Reflect.get(a,u(n+16)),b=S(n+32),D=Reflect.apply(x,a,b);n=this._inst.exports.getsp()>>>0,h(n+56,D),this.mem.setUint8(n+64,1)}catch(a){n=this._inst.exports.getsp()>>>0,h(n+56,a),this.mem.setUint8(n+64,0)}},"syscall/js.valueInvoke":n=>{n>>>=0;try{const a=c(n+8),x=S(n+16),b=Reflect.apply(a,void 0,x);n=this._inst.exports.getsp()>>>0,h(n+40,b),this.mem.setUint8(n+48,1)}catch(a){n=this._inst.exports.getsp()>>>0,h(n+40,a),this.mem.setUint8(n+48,0)}},"syscall/js.valueNew":n=>{n>>>=0;try{const a=c(n+8),x=S(n+16),b=Reflect.construct(a,x);n=this._inst.exports.getsp()>>>0,h(n+40,b),this.mem.setUint8(n+48,1)}catch(a){n=this._inst.exports.getsp()>>>0,h(n+40,a),this.mem.setUint8(n+48,0)}},"syscall/js.valueLength":n=>{n>>>=0,d(n+16,parseInt(c(n+8).length))},"syscall/js.valuePrepareString":n=>{n>>>=0;const a=j.encode(String(c(n+8)));h(n+16,a),d(n+24,a.length)},"syscall/js.valueLoadString":n=>{n>>>=0;const a=c(n+8);_(n+16).set(a)},"syscall/js.valueInstanceOf":n=>{n>>>=0,this.mem.setUint8(n+24,c(n+8)instanceof c(n+16)?1:0)},"syscall/js.copyBytesToGo":n=>{n>>>=0;const a=_(n+8),x=c(n+32);if(!(x instanceof Uint8Array||x instanceof Uint8ClampedArray)){this.mem.setUint8(n+48,0);return}const b=x.subarray(0,a.length);a.set(b),d(n+40,b.length),this.mem.setUint8(n+48,1)},"syscall/js.copyBytesToJS":n=>{n>>>=0;const a=c(n+8),x=_(n+16);if(!(a instanceof Uint8Array||a instanceof Uint8ClampedArray)){this.mem.setUint8(n+48,0);return}const b=x.subarray(0,a.length);a.set(b),d(n+40,b.length),this.mem.setUint8(n+48,1)},debug:n=>{console.log(n)}}}}run(d){return M(this,null,function*(){if(!(d instanceof WebAssembly.Instance))throw new Error("Go.run: WebAssembly.Instance expected");this._inst=d,this.mem=new DataView(this._inst.exports.mem.buffer),this._values=[NaN,0,null,!0,!1,O,this],this._goRefCounts=new Array(this._values.length).fill(1/0),this._ids=new Map([[0,1],[null,2],[!0,3],[!1,4],[O,5],[this,6]]),this._idPool=[],this.exited=!1;let s=4096;const c=E=>{const n=s,a=j.encode(E+"\0");return new Uint8Array(this.mem.buffer,s,a.length).set(a),s+=a.length,s%8!==0&&(s+=8-s%8),n},h=this.argv.length,_=[];this.argv.forEach(E=>{_.push(c(E))}),_.push(0),Object.keys(this.env).sort().forEach(E=>{_.push(c(`${E}=${this.env[E]}`))}),_.push(0);const u=s;if(_.forEach(E=>{this.mem.setUint32(s,E,!0),this.mem.setUint32(s+4,0,!0),s+=8}),s>=12288)throw new Error("total length of command line and environment variables exceeds limit");this._inst.exports.run(h,u),this.exited&&this._resolveExitPromise(),yield this._exitPromise})}_resume(){if(this.exited)throw new Error("Go program has already exited");this._inst.exports.resume(),this.exited&&this._resolveExitPromise()}_makeFuncWrapper(d){const s=this;return function(){const c={id:d,this:this,args:arguments};return s._pendingEvent=c,s._resume(),c.result}}}})(),F=({data:P})=>{let j=new TextDecoder,w=O.fs,d="";w.writeSync=(S,u)=>{if(S===1)R(u);else if(S===2){d+=j.decode(u);let p=d.split(`
`);p.length>1&&console.log(p.slice(0,-1).join(`
`)),d=p[p.length-1]}else throw new Error("Bad write");return u.length};let s=[],c,h=0;F=({data:S})=>(S.length>0&&(s.push(S),c&&c()),_),w.read=(S,u,p,E,n,a)=>{if(S!==0||p!==0||E!==u.length||n!==null)throw new Error("Bad read");if(s.length===0){c=()=>w.read(S,u,p,E,n,a);return}let x=s[0],b=Math.max(0,Math.min(E,x.length-h));u.set(x.subarray(h,h+b),p),h+=b,h===x.length&&(s.shift(),h=0),a(null,b)};let _=new O.Go;return _.argv=["","--service=0.27.7"],W(P,_).then(S=>{R(null),_.run(S)},S=>{R(S)}),_};function W(P,j){return M(this,null,function*(){if(P instanceof WebAssembly.Module)return WebAssembly.instantiate(P,j.importObject);const w=yield fetch(P);if(!w.ok)throw new Error(`Failed to download ${JSON.stringify(P)}`);if("instantiateStreaming"in WebAssembly&&/^application\/wasm($|;)/i.test(w.headers.get("Content-Type")||""))return(yield WebAssembly.instantiateStreaming(w,j.importObject)).instance;const d=yield w.arrayBuffer();return(yield WebAssembly.instantiate(d,j.importObject)).instance})}return P=>F(P)})(R=>o.onmessage({data:R})),I;o={onmessage:null,postMessage:R=>setTimeout(()=>{try{I=T({data:R})}catch(M){m(M)}}),terminate(){if(I)for(let R of I._scheduledTimeouts.values())clearTimeout(R)}}}let f,v;const l=new Promise((T,I)=>{f=T,v=I});o.onmessage=({data:T})=>{o.onmessage=({data:I})=>y(I),T?v(T):f()},o.postMessage(t||new URL(e,location.href).toString());let{readFromStdout:y,service:k}=ht({writeToStdin(T){o.postMessage(T)},isSync:!1,hasFS:!1,esbuild:Se});yield l,Ae=()=>{o.terminate(),ge=void 0,Ae=void 0,De=void 0},De={build:T=>new Promise((I,R)=>{g.then(R),k.buildOrContext({callName:"build",refs:null,options:T,isTTY:!1,defaultWD:"/",callback:(M,F)=>M?R(M):I(F)})}),context:T=>new Promise((I,R)=>{g.then(R),k.buildOrContext({callName:"context",refs:null,options:T,isTTY:!1,defaultWD:"/",callback:(M,F)=>M?R(M):I(F)})}),transform:(T,I)=>new Promise((R,M)=>{g.then(M),k.transform({callName:"transform",refs:null,input:T,options:I||{},isTTY:!1,fs:{readFile(F,O){O(new Error("Internal error"),null)},writeFile(F,O){O(null)}},callback:(F,O)=>F?M(F):R(O)})}),formatMessages:(T,I)=>new Promise((R,M)=>{g.then(M),k.formatMessages({callName:"formatMessages",refs:null,messages:T,options:I,callback:(F,O)=>F?M(F):R(O)})}),analyzeMetafile:(T,I)=>new Promise((R,M)=>{g.then(M),k.analyzeMetafile({callName:"analyzeMetafile",refs:null,metafile:typeof T=="string"?T:JSON.stringify(T),options:I,callback:(F,O)=>F?M(F):R(O)})})}}),At=Se})(ve)})(Ie)),Ie.exports}var Ze=Nt();const Mt=Ut(Ze),Vt=It({__proto__:null,default:Mt},[Ze]);export{Vt as b};
