import {expect,it,vi} from 'vitest';
import {webRead,webSearch,rankSearchResults,webStatus} from '../server/research-web';
import {publicFetch} from '../server/public-fetch';
it('renders Maps through the anonymous browser without static fetch or API calls',async()=>{
 const browser=vi.fn(async()=>({url:'https://www.google.com/maps/place/fixture',text:'Fixture 5.0',rendered:true,ratingLabels:['5.0 stars']}));
 const fetcher=vi.fn();
 const result=await webRead('https://maps.google.com/?cid=777',20000,fetcher,'browser',browser);
 expect(fetcher).not.toHaveBeenCalled();expect(browser).toHaveBeenCalledWith({action:'read',url:'https://maps.google.com/?cid=777',maxChars:20000});expect(result.rendered).toBe(true);
});
it('preserves evidence of blocked pages and never invents reviews',async()=>{
 const result=await webRead('https://example.org',1000,undefined,'browser',async()=>({text:'Verify human',blocked:'captcha_or_access_denied',rendered:true}));
 expect(result.blocked).toBe('captcha_or_access_denied');expect(result).not.toHaveProperty('reviewCount');
 await expect(webRead('https://127.0.0.1',1000,undefined,'browser',async()=>({}))).rejects.toThrow();
});
it('filters unrelated RSS results rather than presenting them as useful search evidence',()=>{
 expect(rankSearchResults('Asian Corner Belgrade',[{title:'Microsoft stock',url:'https://example.org/stock',snippet:'markets'},{title:'Asian Corner restaurant',url:'https://example.org/asian',snippet:'Belgrade Makenzijeva 68'}],5)).toHaveLength(1);
});
it('uses browser results first and reports browser readiness without loading a site',async()=>{
 const browser=vi.fn(async()=>({provider:'google',results:[{title:'Asian Corner',url:'https://example.org/corner',snippet:'Belgrade'}],available:true}));
 const result=await webSearch('Asian Corner Belgrade',5,publicFetch,'auto',browser);expect(result.provider).toBe('google');expect(browser).toHaveBeenCalledOnce();
 const status=await webStatus(async()=>({available:true,javascript:true}));expect(status.browser.available).toBe(true);
});
