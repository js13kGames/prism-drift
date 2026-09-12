// Validation harness for glass fit bug. Uses exact formulas from index.html.
const M = Math;
const TAU = 6.2831853, SIDES = 14;
function smooth(s){var t=(s-64)/32;t=t<0?0:t>1?1:t;return t*t*(3-2*t);}
function cen(s){var g=smooth(s);return[g*(10*M.sin(.021*s)+6*M.sin(.037*s+1)+3*M.sin(.071*s+2)),g*(8*M.cos(.017*s)+5*M.sin(.043*s+3)+2*M.cos(.061*s))];}
function rad(s,a){var g=smooth(s),base=20-6*g+2*g*M.sin(.03*s+5)+1.5*g*M.sin(.057*s+1),bump=g*(1.8*M.sin(3*a+.09*s)+1.2*M.sin(5*a-.05*s+2)+.8*M.cos(7*a+.12*s));return base+bump;}

// OLD fit: corners vs angle-dependent smooth rad
function gFitsOld(z,cx,cy,x,y,hw,hh,mrg){for(var q=0;q<4;q++){var ex=q<2?hw:-hw,ey=(q&1)?hh:-hh,dx=x+ex-cx,dy=y+ey-cy;if(M.hypot(dx,dy)>rad(z,M.atan2(dy,dx))-mrg)return false;}return true;}

// NEW conservative fit: guaranteed inscribed circle of the actual mesh cross-section
// polygon (SIDES-gon whose vertices lie on the smooth rad curve at this z), centered
// at tunnel center. Disk is convex, so containment of the farthest rectangle corner
// guarantees the whole rectangle (all edges/interior) lies inside the disk => inside tunnel.
function inscribedR(z,cx,cy){
  var vx=new Array(SIDES),vy=new Array(SIDES),j,a,r;
  for(j=0;j<SIDES;j++){a=j/SIDES*TAU;r=rad(z,a);vx[j]=cx+r*M.cos(a);vy[j]=cy+r*M.sin(a);}
  var best=Infinity;
  for(j=0;j<SIDES;j++){
    var k=(j+1)%SIDES,ax=vx[j],ay=vy[j],bx=vx[k],by=vy[k];
    // perpendicular distance from tunnel center (cx,cy) to the infinite line AB
    var ex=bx-ax,ey=by-ay,L=M.hypot(ex,ey);
    var d=M.abs((cx-ax)*ey-(cy-ay)*ex)/L; // origin(center) to line AB
    if(d<best)best=d;
  }
  return best;
}
function gFitsNew(z,cx,cy,x,y,hw,hh,mrg){
  var ins=inscribedR(z,cx,cy),far=0;
  for(var q=0;q<4;q++){var ex=q<2?hw:-hw,ey=(q&1)?hh:-hh,d=M.hypot(x+ex-cx,y+ey-cy);if(d>far)far=d;}
  return far<=ins-mrg;
}

// Ground truth: dense perimeter sampling against smooth rad AND polygon edges.
function pointInsideSmooth(z,cx,cy,px,py,mrg){
  var dx=px-cx,dy=py-cy;return M.hypot(dx,dy)<=rad(z,M.atan2(dy,dx))-mrg;
}
// dense sample of rectangle perimeter
function trueFits(z,cx,cy,x,y,hw,hh,mrg,N){
  N=N||400;
  var pts=[],i,t;
  for(i=0;i<=N;i++){t=-hw+2*hw*i/N;pts.push([x+t,y+hh],[x+t,y-hh]);}
  for(i=0;i<=N;i++){t=-hh+2*hh*i/N;pts.push([x+hw,y+t],[x-hw,y+t]);}
  for(var p=0;p<pts.length;p++){if(!pointInsideSmooth(z,cx,cy,pts[p][0],pts[p][1],mrg))return false;}
  return true;
}

// ---- Regression repro case ----
var Z=1406.86378178391, X=-10.700208697960205, Y=2.689603206419423, HW=2.6473246582857115, HH=2.3467632517575847, MRG=1.2;
var cc=cen(Z),cx=cc[0],cy=cc[1];
console.log("cen:",cx.toFixed(4),cy.toFixed(4));
console.log("OLD gFits:",gFitsOld(Z,cx,cy,X,Y,HW,HH,MRG));
console.log("TRUE fits(smooth,dense):",trueFits(Z,cx,cy,X,Y,HW,HH,MRG,800));
console.log("NEW gFits:",gFitsNew(Z,cx,cy,X,Y,HW,HH,MRG));
// measure worst left-edge deficiency
var worst=0,N=800;
for(var i=0;i<=N;i++){var t=-HH+2*HH*i/N,px=X-HW,py=Y+t,dx=px-cx,dy=py-cy,clr=rad(Z,M.atan2(dy,dx))-MRG-M.hypot(dx,dy);if(clr<worst)worst=clr;}
console.log("worst left-edge clearance deficit:",worst.toFixed(4));

// ---- Soundness sweep: NEW must NEVER report fit when TRUE says no ----
function rnd(a,b){return a+Math.random()*(b-a);}
var trials=200000,falsePos=0,falseNeg=0,newYes=0,oldYes=0,oldFalsePos=0;
for(var it=0;it<trials;it++){
  var z=rnd(70,3000),c=cen(z),Cx=c[0],Cy=c[1],R=rad(z,0);
  var hw=rnd(2.2,3.6),hh=rnd(2.2,3.6);
  var x=Cx+rnd(-1,1)*R*.55,y=Cy+rnd(-1,1)*R*.55;
  var tf=trueFits(z,Cx,Cy,x,y,hw,hh,MRG,300);
  var nf=gFitsNew(z,Cx,Cy,x,y,hw,hh,MRG);
  var of=gFitsOld(z,Cx,Cy,x,y,hw,hh,MRG);
  if(nf&&!tf)falsePos++;
  if(!nf&&tf)falseNeg++;
  if(of&&!tf)oldFalsePos++;
  if(nf)newYes++; if(of)oldYes++;
}
console.log("\nSweep trials:",trials);
console.log("NEW false positives (claims fit but truly doesn't):",falsePos);
console.log("NEW conservative rejections (safe, truly fits but NEW says no):",falseNeg);
console.log("OLD false positives (the bug):",oldFalsePos);
console.log("NEW accept rate:",(newYes/trials*100).toFixed(1)+"%","OLD accept rate:",(oldYes/trials*100).toFixed(1)+"%");
