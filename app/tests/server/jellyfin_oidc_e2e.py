import json,urllib.request,urllib.parse,http.cookiejar,secrets,re,sys,time,os
D=os.environ.get('SEEMORE_DIR','/opt/seemore')
E=dict(l.split('=',1) for l in open(D+'/.env').read().splitlines() if '=' in l and not l.startswith('#'))
C=dict(l.split('=',1) for l in open(D+'/config.env').read().splitlines() if '=' in l and not l.startswith('#'))
PUB='https://'+C['PANEL_PUBLIC_HOST']; JF='https://jellyfin.'+C['PANEL_PUBLIC_HOST'].split('.',1)[1]
class NoRedir(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*a,**k): return None
def br():
    jar=http.cookiejar.CookieJar(); return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar),NoRedir),jar
def call(op,method,url,body=None,hdr=None,origin=None):
    r=urllib.request.Request(url,data=json.dumps(body).encode() if body is not None else None,method=method)
    if body is not None: r.add_header('Content-Type','application/json')
    for k,v in (hdr or {}).items(): r.add_header(k,v)
    try:
        x=op.open(r,timeout=40); return x.status,dict(x.headers),x.read().decode(errors='replace')
    except urllib.error.HTTPError as e: return e.code,dict(e.headers),e.read().decode(errors='replace')
class P:
    def __init__(s,base=None): s.op,s.jar=br(); s.csrf=''; s.base=base or PUB
    def api(s,m,p,b=None):
        h={'Origin':s.base,'X-CSRF-Token':s.csrf} if m!='GET' else {}
        st,_,t=call(s.op,m,s.base+'/api/v1'+p,b,h)
        try: return st,json.loads(t)
        except Exception: return st,t
    def login(s,u,p):
        st,j=s.api('POST','/auth/login',{'username':u,'password':p}); 
        if st==200: s.csrf=j['csrf']
        return st
o=P(); assert o.login(C.get('PANEL_OWNER_USER','admin'),E[C.get('PANEL_OWNER_PASS_ENV','JELLYFIN_PASS')])==200
pw=secrets.token_urlsafe(14); jpw=secrets.token_urlsafe(14)
U=[(999000011,'oidc-ok',['svc.jellyfin']),(999000012,'oidc-no',['library']),(999000013,'oidc-adm',['svc.jellyfin'])]
try:
    for uid,name,perms in U:
        o.api('POST','/users',{'uid':uid,'name':'oidc test (temporary)','perms':perms,'expires':int(time.time()*1000)+3600000}); o.api('PUT',f'/panel-accounts/{name}',{'uid':uid,'password':pw})
    LANJ='http://jellyfin.'+C['PANEL_LAN_HOST'].split('.',1)[1]; LANP='http://'+C['PANEL_LAN_HOST']
    DOM={'pub':(JF,PUB,'seemore'),'lan':(LANJ,LANP,'seemore-lan')}
    def oidc(name,dom='pub',who=None):
        jb,pb,prov=DOM[dom]; b=P(pb); url=jb+'/__oidc'; logged=False; trail=[]
        for _ in range(12):
            st,h,t=call(b.op,'GET',url); trail.append(urllib.parse.urlsplit(url).netloc)
            if st in (301,302,303,307,308):
                nxt=urllib.parse.urljoin(url,h['Location'])
                if urllib.parse.urlsplit(nxt).path=='/login' and not logged:   # the panel's normal login page: log in like the UI does, then follow ?next
                    q=urllib.parse.parse_qs(urllib.parse.urlsplit(nxt).query); nx=q['next'][0]; assert nx.startswith('/oidc/authorize?')
                    u,pw_=who if who else (name,pw); assert b.login(u,pw_)==200; logged=True; trail.append('login@'+urllib.parse.urlsplit(nxt).netloc); nxt=urllib.parse.urljoin(nxt,nx)
                url=nxt
            else: break
        return b,st,t,url,trail
    R=[]
    def rec(n,ok,i=''): R.append(ok); print(('PASS ' if ok else 'FAIL ')+n+(' - '+str(i) if i else ''),flush=True)
    A='MediaBrowser Client="seemore-test", Device="server", DeviceId="seemore-test", Version="1.0"'
    jop=urllib.request.build_opener()
    def jf(m,p,b=None,tok=None,base='http://localhost:8096'):
        st,h,t=call(jop,m,base+p,b,{'Authorization':A+(f', Token="{tok}"' if tok else '')})
        try: return st,json.loads(t)
        except Exception: return st,t
    owner_pw=E[C.get('PANEL_OWNER_PASS_ENV','JELLYFIN_PASS')]; ou=E['JELLYFIN_USER']
    s,j=jf('POST','/Users/AuthenticateByName',{'Username':ou,'Pw':owner_pw}); rec('native: owner password login to Jellyfin',s==200); adm=j['AccessToken']
    s,q=jf('GET','/QuickConnect/Enabled'); rec('native: Quick Connect still enabled',s==200 and q is True,q)
    s,n=jf('POST','/Users/New',{'Name':'oidc-native','Password':jpw},adm); s2,_=jf('POST','/Users/AuthenticateByName',{'Username':'oidc-native','Pw':jpw}); rec('native: ordinary user password login',s2==200)
    s,a=jf('POST','/Users/New',{'Name':'oidc-adm','Password':secrets.token_urlsafe(12)},adm)
    p=a['Policy']; p['IsAdministrator']=True; jf('POST',f"/Users/{a['Id']}/Policy",p,adm)
    def finish(name,dom='pub',who=None):
        b,st,t,url,hops=oidc(name,dom,who)
        m=re.search(r"var data = '([^']+)'",t)
        if not m: return None,st,url
        s,r=jf('POST','/sso/OID/Auth/seemore',{'deviceId':'t-'+str(name),'appName':'Jellyfin Web','appVersion':'10.8.0','deviceName':'test','data':m.group(1)},None,DOM[dom][0])
        return (r if s==200 and isinstance(r,dict) else None),s,hops
    def libs(): 
        s,v=jf('GET','/Library/VirtualFolders',None,adm); return {x['ItemId']:x['Name'] for x in v}
    L=libs()
    r,s,u=finish('oidc-ok'); rec('OIDC public: flow stays on the public hosts',all((C['PANEL_LAN_HOST'].split('.',1)[1] not in x) for x in u),u)
    rec('OIDC: panel user with svc.jellyfin signs in',bool(r and r.get('AccessToken')),s)
    if r:
        pol=r['User']['Policy']; rec('OIDC: account is the user\'s own (not owner), not admin, explicit libraries',r['User']['Name']=='oidc-ok' and not pol['IsAdministrator'] and not pol['EnableAllFolders'] and sorted(pol['EnabledFolders'])==sorted(k for k,v in L.items() if v in ('Movies','TV Shows')),f"{len(pol['EnabledFolders'])} libs")
        jf('POST','/Sessions/Logout',None,r['AccessToken'])
    r,s,u=finish('oidc-no'); rec('OIDC: panel user without svc.jellyfin is denied (no token)',r is None,s)
    s,us=jf('GET','/Users',None,adm); names=[x['Name'] for x in us]
    rec('OIDC: denied user got no Jellyfin account',"oidc-no" not in names)
    r,s,u=finish('oidc-adm'); rec('OIDC: panel user named like a Jellyfin administrator is denied',r is None,s)
    sa,_,_=call(jop,'GET','http://localhost:8096/Users/Public'); 
    ou_who=(C.get('PANEL_OWNER_USER','admin'),owner_pw)
    for dom in ('pub','lan'):
        r,s,u=finish(None,dom,ou_who)
        rec(f'OIDC {dom}: owner signs in as the owner Jellyfin account (admin), no "Bad origin"',bool(r and r.get('User',{}).get('Name','').lower()==ou.lower() and r['User']['Policy']['IsAdministrator']),u)
        if r: jf('POST','/Sessions/Logout',None,r.get('AccessToken'))
        if dom=='lan': rec('OIDC lan: panel login happened on the LAN panel host (http)',any(x=='login@'+C['PANEL_LAN_HOST'] for x in u),u)
        else: rec('OIDC public: panel login happened on the public panel host',any(x=='login@'+C['PANEL_PUBLIC_HOST'] for x in u),u)
    r,s,u=finish('oidc-ok','lan'); rec('OIDC lan: permitted panel user signs in (own non-admin account)',bool(r and r['User']['Name']=='oidc-ok' and not r['User']['Policy']['IsAdministrator']),s)
    if r: jf('POST','/Sessions/Logout',None,r.get('AccessToken'))
    r,s,u=finish('oidc-no','lan'); rec('OIDC lan: user without svc.jellyfin denied',r is None,s)
    ob=P(); ob.login(*ou_who)
    st,_,_=call(ob.op,'GET',PUB+'/oidc/authorize?client_id=seemore-jellyfin&response_type=code&redirect_uri=https%3A%2F%2Fevil.example%2Fx'); rec('OIDC: unregistered redirect_uri rejected',st==400,st)
    st,_,_=call(P().op,'POST',PUB+'/oidc/login',None); rec('old separate OIDC login form is gone',st in (404,405,403),st)
    st,h,t=call(ob.op,'GET',JF+'/__sso'); rec('owner one-click /__sso fallback still works',st==200 and 'jellyfin_credentials' in t,st)
    s,_=jf('POST','/Users/AuthenticateByName',{'Username':ou,'Pw':owner_pw}); rec('native: owner password login still works after OIDC',s==200)
    st,_,bt=call(jop,'GET',JF+'/Branding/Configuration'); rec('login page has the SeeMore button',st==200 and '/__oidc' in bt)
    print(f'RESULT {sum(R)}/{len(R)}')
finally:
    try:
        s,j=jf('POST','/Users/AuthenticateByName',{'Username':ou,'Pw':owner_pw}); adm=j['AccessToken']
        for x in jf('GET','/Users',None,adm)[1]:
            if x['Name'] in ('oidc-ok','oidc-no','oidc-adm','oidc-native'): jf('DELETE','/Users/'+x['Id'],None,adm)
        print('left',[x['Name'] for x in jf('GET','/Users',None,adm)[1]]); jf('POST','/Sessions/Logout',None,adm)
    except Exception as e: print('cleanup error',e)
    for uid,name,perms in U:
        o.api('DELETE',f'/panel-accounts/{name}'); o.api('DELETE',f'/users/{uid}')
    print('panel users cleaned')
