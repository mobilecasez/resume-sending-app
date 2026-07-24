// AI Hub — new feature. Safe to delete without affecting existing app.
//
// What the app hands the extractor when a user taps "Fetch job".
//
// A job page is never just the posting. It also carries top navigation, a cookie banner, a contact
// form, a footer — and the one that actually costs us: a "more open roles" strip of short cards,
// each holding another role's title plus a one-line marketing tagline. On growtheroses.co.uk the
// card for the very job being fetched sat in that strip, and the extractor preferred its tagline
// ("Code. Build. Deploy. Innovate end-to-end. Scale impact.") over the page's real About the Role /
// Responsibilities / Requirements body.
//
// So we send BOTH: the full body text exactly as before — so this can never take away content the
// server used to see — plus the main content region for pages that mark one up. The server uses the
// main region only when it looks like a real posting body, and falls back to the full text.
export const PAGE_TEXT_FN = `
function cvfMainText(){
  try{
    var sels = ['main','[role=main]','article','[itemprop="description"]','#content','#main-content',
                '#job-description','.job-description','.job-details','.job-post','.posting','.opening'];
    var best = '';
    for (var s = 0; s < sels.length; s++){
      var els; try { els = document.querySelectorAll(sels[s]); } catch(e){ continue; }
      for (var i = 0; i < els.length && i < 6; i++){
        var t = ''; try { t = els[i].innerText || ''; } catch(e){}
        if (t.length > best.length) best = t;
      }
    }
    return best;
  }catch(e){ return ''; }
}`;
