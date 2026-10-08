## Glossary

Terminology varies by context, and one word can mean different 
things depending on who you ask. 

The definitions below reflect how these terms are used in the xdd-smash context.

**bidder.** In OpenRTB, anything that receives a bid request and returns 
a bid response. On the Publisher page it also means one entry in a bidder list: 
the declaration through which a wrapper or server knows to call it.

**bidding engine.** The engine that sets an auction price and picks a winner. 
On audience pages this always means the engine you run the auction in, 
never the xdd-smash framework.

**ctx.** The bid request after the framework has normalized it into one shape, 
whatever the caller sent. Every hook receives it, changes it, 
and returns it. See [framework docs](../framework.md).

**curator.** A company that packages a view of the inventory and sells it 
through a deal ID. Most curators work inside an SSP's curation platform: 
they load data and rules there, and the SSP builds the deal. The Curator 
page is written for the case where requests pass through the curator's 
own infrastructure.

**deal ID.** The identifier a packaged set of inventory, data and rules 
is sold under. A buyer targets it in their DSP the way they target any 
private marketplace. It is issued by whoever holds the seat relationship with 
the demand, which is why the xdd-smash framework can run the rules behind 
a package without making the package buyable.

**DPO.** Demand path optimization: choosing which of your demand partners 
are worth keeping, and cutting the paths that reach the same buyer twice. 
The mirror of SPO, from the seller's side.

**DTE.** Dynamic Traffic Engine, a file-based traffic shaping system that 
Amazon Ads donated to IAB Tech Lab's Open Source Initiative. A demand-side 
platform declares which kinds of bid requests it prioritizes for a period, 
and the sell side shapes what it sends accordingly.

**enrichment.** Adding data to a request before it goes out.

**fail-open.** Returning `ctx` when an external dependency a feature relies on 
is unreachable, so no bid is lost to infrastructure. Required of stateful 
features, and the xdd-smash framework does not do it for you: nothing is 
caught silently on your behalf.

**feature.** A directory under `features/`, picked up at startup. Its `index.js` 
declares the stages it binds to. This is the unit of packaging. You write it 
yourself, and adding one is adding a directory. Features are either stateless 
or stateful: a stateful one depends on Redis or something else over the network 
and must fail open.

**floor.** Two different things depending on the direction. What your ad server 
or wrapper accepts from bidders, and what you ask for on a request going 
out to one of your own paths.

**hook.** A function bound to one of four stages: `prebid-ssp`, `prebid-dsp`, 
`postbid-dsp`, `postbid-ssp`. It receives `ctx`, changes it, and returns it. 
Returning `null` ends the request as a no-bid.

**MMP.** Mobile measurement partner. The tracker for apps, and a neutral 
third party that decides which network gets credit for an install.

**path.** One route from you to one buyer. The same impression usually has 
several, and each one is declared somewhere: a bidder list, an ad server, 
a config file. Not the chain of intermediaries between you and the buyer, 
which the pages call the supply chain.

**performance network.** On these pages, an RTB network that buys on CPM 
and earns on conversions. It does not cover affiliate networks handing offers 
to their own affiliates, or traffic distribution systems, where the object 
in the path is a click and there is no bid request.

**postback.** A server-to-server call that reports an event after the fact. 
On the Performance Network page it means the conversion call a tracker receives, 
carrying a click ID rather than anything about the impression, sometimes days 
later and revisable as a status changes.

**rule.** One unit of intent: a condition you want applied. A rule is often 
exactly one hook on one stage, which is why the Curator page puts it that way. 
It can also mean several hooks across stages, or a feature that reads state 
before deciding.

**schain.** The object in a request declaring the chain of intermediaries it 
came through. Buyers read it, against `sellers.json`, to decide whether a path 
is worth bidding on.

**seat.** A buyer's account at a DSP, and the level at which a hook can be 
scoped: the same combination can be withheld from one seat and sent to the rest.

**signal.** What your own data says about something, read while a request is 
being handled.

**SPO.** Supply path optimization, a buy-side term for cutting the number of 
paths a buyer uses.

**tracker.** The system that collects postbacks and works out what converts.

**traffic shaping.** Controlling which requests go out to which 
demand partner, at what rate and through which path. The pages shorten it 
to shaping.

**wrapper.** The layer on the page or in the app that runs the header bidding 
auction and calls each bidder in its list.
