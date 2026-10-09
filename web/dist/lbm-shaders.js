// D3Q19 regularized LBM with Smagorinsky SGS viscosity, all flow updates on GPU.
// SI-to-lattice conversion lives in flow-state.js. No prescribed vortices or
// trajectory-force surrogate enters this solver. Geometry: smooth rotating sphere.
export const C = [
  [0, 0, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
  [1, 1, 0],
  [-1, -1, 0],
  [1, -1, 0],
  [-1, 1, 0],
  [1, 0, 1],
  [-1, 0, -1],
  [1, 0, -1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, -1],
  [0, 1, -1],
  [0, -1, 1],
];
export const W = C.map((c, i) => (i === 0 ? 1 / 3 : i < 7 ? 1 / 18 : 1 / 36));
const OPP = C.map((c) => C.findIndex((d) => d.every((v, k) => v === -c[k])));
const constants = `const C=array<vec3i,19>(${C.map((c) => `vec3i(${c.join(',')})`).join(',')});
const W=array<f32,19>(${W.map((w) => `${w}`).join(',')});
const OPP=array<u32,19>(${OPP.map((v) => `${v}u`).join(',')});`;
export const shader =
  constants +
  `
struct Params { dims:vec4u, sphere:vec4f, fluid:vec4f, omega:vec4f, extra:vec4f }
struct Cell { flow:vec4f, info:vec4f, force:vec4f }
@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var<storage,read> src:array<f32>;
@group(0) @binding(2) var<storage,read_write> dst:array<f32>;
@group(0) @binding(3) var<storage,read_write> cells:array<Cell>;
fn xyz(id:u32)->vec3i{return vec3i(i32(id%p.dims.x),i32(id/p.dims.x%p.dims.y),i32(id/(p.dims.x*p.dims.y)));}
fn idx(v:vec3i)->u32{return u32(v.x)+p.dims.x*(u32(v.y)+p.dims.y*u32(v.z));}
fn solid(v:vec3i)->bool {return p.extra.x==0.0 && length(vec3f(v)-p.sphere.xyz)<p.sphere.w;}
fn equilibrium(i:u32,rho:f32,u:vec3f)->f32 {let cu=dot(vec3f(C[i]),u);return W[i]*rho*(1.0+3.0*cu+4.5*cu*cu-1.5*dot(u,u));}
@compute @workgroup_size(128)
fn initialize(@builtin(global_invocation_id) gid:vec3u){
 let id=gid.x;let n=p.dims.w;if(id>=n){return;}let v=xyz(id);
 var u=vec3f(p.fluid.x,0,0);
 if(p.extra.x==1.0){u=vec3f(0,0.005*sin(6.28318530718*f32(v.x)/f32(p.dims.x)),0);}
 if(p.extra.x==3.0){u=vec3f(0,0,0.005*sin(6.28318530718*f32(v.y)/f32(p.dims.y)));}
 if(p.extra.x==4.0){u=vec3f(0.005*sin(6.28318530718*f32(v.z)/f32(p.dims.z)),0,0);}
 if(p.extra.x==0.0){
   // A single deterministic, localized 0.1% initial perturbation breaks symmetry.
   let r=(vec3f(v)-p.sphere.xyz)/max(1.0,p.sphere.w);
   u.y+=p.fluid.x*.001*sin(dot(r,vec3f(1.2,2.1,1.7))+p.extra.y)*exp(-dot(r,r)*.15);
 }
 if(solid(v)){u=vec3f(0);}
 for(var i=0u;i<19u;i++){dst[i*n+id]=equilibrium(i,1.0,u);}
 cells[id]=Cell(vec4f(u,1),vec4f(0),vec4f(0));
}
@compute @workgroup_size(128)
fn step(@builtin(global_invocation_id) gid:vec3u){
 let id=gid.x;let n=p.dims.w;if(id>=n){return;}let v=xyz(id);
 if(solid(v)){cells[id]=Cell(vec4f(0),vec4f(0),vec4f(0));return;}
 // Dirichlet equilibrium at inlet and transverse far field; zero-gradient outlet.
 if(p.extra.x==0.0 && (v.x==0||v.y==0||v.z==0||v.y==i32(p.dims.y)-1||v.z==i32(p.dims.z)-1)){
   let u=vec3f(p.fluid.x,0,0);
   for(var i=0u;i<19u;i++){dst[i*n+id]=equilibrium(i,1.0,u);}
   cells[id]=Cell(vec4f(u,1),vec4f((p.fluid.y-.5)/3.0,0,0,1),vec4f(0));return;
 }
 if(p.extra.x==0.0 && v.x==i32(p.dims.x)-1){
   var rho=0.0;var m=vec3f(0);
   for(var i=0u;i<19u;i++){let f=src[i*n+id-1u];dst[i*n+id]=f;rho+=f;m+=f*vec3f(C[i]);}
   cells[id]=Cell(vec4f(m/rho,rho),vec4f(0,0,0,1),vec4f(0));return;
 }
 var f:array<f32,19>;var rho=0.0;var mom=vec3f(0);var force=vec3f(0);var wallRho=0.0;
 for(var i=0u;i<19u;i++){
   var upstream=v-C[i];
   if(p.extra.x>0.0){upstream=(upstream+vec3i(p.dims.xyz))%vec3i(p.dims.xyz);}
   if(solid(upstream)){
     if(wallRho==0.0){for(var j=0u;j<19u;j++){wallRho+=src[j*n+id];}}
     // Half-way moving-wall bounce-back. C[i] points FROM wall INTO fluid.
     let wall=vec3f(v)-0.5*vec3f(C[i])-p.sphere.xyz;
     let uw=cross(p.omega.xyz,wall);
     let outgoing=src[OPP[i]*n+id];
     f[i]=outgoing+6.0*W[i]*wallRho*dot(vec3f(C[i]),uw);
     force-=(outgoing+f[i])*vec3f(C[i]);
   }else{f[i]=src[i*n+idx(upstream)];}
   rho+=f[i];mom+=f[i]*vec3f(C[i]);
 }
 let u=mom/rho;var diag=vec3f(0);var off=vec3f(0);
 for(var i=0u;i<19u;i++){
   let c=vec3f(C[i]);let neq=f[i]-equilibrium(i,rho,u);
   diag+=neq*c*c;off+=neq*vec3f(c.x*c.y,c.x*c.z,c.y*c.z);
 }
 // |Pi_neq| = sqrt(Pi:Pi); Cs is squared here, filter width = one lattice cell.
 let norm=sqrt(dot(diag,diag)+2.0*dot(off,off));
 let tau=.5*(p.fluid.y+sqrt(p.fluid.y*p.fluid.y+18.0*p.fluid.z*p.fluid.z*sqrt(2.0)*norm/rho));
 var neqReg:array<f32,19>;var alpha=1.0;
 for(var i=0u;i<19u;i++){
   let c=vec3f(C[i]);let contraction=dot(c*c-vec3f(1.0/3.0),diag)+2.0*dot(vec3f(c.x*c.y,c.x*c.z,c.y*c.z),off);
   neqReg[i]=(1.0-1.0/tau)*4.5*W[i]*contraction;
   // One common scaling for all populations preserves mass and momentum.
   if(neqReg[i]<0.0){alpha=min(alpha,.999*equilibrium(i,rho,u)/(-neqReg[i]));}
 }
 for(var i=0u;i<19u;i++){dst[i*n+id]=equilibrium(i,rho,u)+alpha*neqReg[i];}
 let invalid=select(1.0,0.0,rho>.8&&rho<1.2&&dot(u,u)<.04&&alpha>=0.0);
 cells[id]=Cell(vec4f(u,rho),vec4f((tau-.5)/3.0,select(0.0,1.0,alpha<.99999),invalid,1),vec4f(force,0));
}
`;
export const postShader = `
struct Params { dims:vec4u, sphere:vec4f, fluid:vec4f, omega:vec4f, extra:vec4f }
struct Cell { flow:vec4f, info:vec4f, force:vec4f }
struct Stats { bounds:vec4f, totals:vec4f, force:vec4f }
@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var<storage,read> cells:array<Cell>;
@group(0) @binding(2) var<storage,read_write> slices:array<vec4f>;
@group(0) @binding(3) var<storage,read_write> stats:array<Stats>;
var<workgroup> tmp:array<Stats,128>;
@compute @workgroup_size(128)
fn reduce(@builtin(global_invocation_id) gid:vec3u,@builtin(local_invocation_index) lid:u32,@builtin(workgroup_id) wid:vec3u){
 var s=Stats(vec4f(1e6,-1e6,0,0),vec4f(0),vec4f(0));
 if(gid.x<p.dims.w){let c=cells[gid.x];if(c.info.w>0.0){
   s=Stats(vec4f(c.flow.w,c.flow.w,length(c.flow.xyz)*sqrt(3.0),c.info.x),vec4f(c.flow.w,c.info.y,c.info.z,1),c.force);
 }}tmp[lid]=s;workgroupBarrier();
 for(var stride=64u;stride>0u;stride/=2u){
   if(lid<stride){let b=tmp[lid+stride];tmp[lid].bounds=vec4f(min(tmp[lid].bounds.x,b.bounds.x),max(tmp[lid].bounds.yzw,b.bounds.yzw));tmp[lid].totals+=b.totals;tmp[lid].force+=b.force;}
   workgroupBarrier();
 }if(lid==0u){stats[wid.x]=tmp[0];}
}
@compute @workgroup_size(128)
fn slice(@builtin(global_invocation_id) gid:vec3u){
 let i=gid.x;let xy=p.dims.x*p.dims.y;let xz=p.dims.x*p.dims.z;let yz=p.dims.y*p.dims.z;
 if(i>=xy+xz+yz){return;}var v:vec3u;
 if(i<xy){v=vec3u(i%p.dims.x,i/p.dims.x,u32(p.sphere.z));}
 else if(i<xy+xz){let j=i-xy;v=vec3u(j%p.dims.x,u32(p.sphere.y),j/p.dims.x);}
 else{let j=i-xy-xz;v=vec3u(u32(p.sphere.x+4.0*p.sphere.w),j%p.dims.y,j/p.dims.y);}
 slices[i]=cells[v.x+p.dims.x*(v.y+p.dims.y*v.z)].flow;
}
`;
