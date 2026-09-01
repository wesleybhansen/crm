import type { Candidate, CandidateEvidence, CandidateIdentity } from '../adapters/types'

export type DemonstratedOpportunityIntent = NonNullable<CandidateIdentity['intent_kind']> | null

export type OpportunityIntentClassification = {
  kind: DemonstratedOpportunityIntent
  buyerSignals: string[]
  sellerSignals: string[]
  localAudienceSignals: string[]
  confidence: number
}

export type OpportunityDestinationAssessment = {
  canonicalUrl: string | null
  status: 'pass' | 'fail' | 'unknown'
  issues: string[]
  newestObservation: string | null
  ageDays: number | null
}

const BUYER_SIGNALS: Array<[string, RegExp]> = [
  [
    'buy a home',
    /\b(?:buy(?:ing)?|purchase|purchasing) (?:a|my|our|the)? ?(?:first|current|next|new|smaller|larger)? ?(?:homes?|houses?|condos?|townhomes?|propert(?:y|ies))\b|\b(?:home|house|condo|townhome|property) (?:purchase|buyer)\b/i,
  ],
  ['home buyer', /\b(?:home|property) ?buyers?\b|\bbuyers? (?:and|or) sellers?\b/i],
  [
    'buy before or after selling',
    /\bbuy(?:ing)? (?:or|before|after) sell(?:ing)? (?:a|my|our|the)? ?(?:home|house|property)\b|\bbuying (?:the )?(?:next|another) one\b/i,
  ],
  ['first-time buyer', /\bfirst[- ]time (?:home ?buyer|buyer|home)\b/i],
  ['home search', /\b(?:house hunt|house hunting|home search|searching for (?:a )?home)\b/i],
  ['financing education', /\b(?:mortgage|pre[- ]?approval|down payment|closing costs?)\b/i],
  ['looking for a home', /\blooking for (?:a )?(?:home|house|condo|townhome)\b/i],
  [
    'actively seeking a property',
    /\b(?:i|we)(?:(?:'m|'re| am| are)|(?:'ve| have)(?: been)?)?\s+(?:waiting|trying|looking)\s+to\s+(?:find|buy|purchase)\s+(?:a|my|our|the)?\s*(?:home|house|condo|townhome|property)\b/i,
  ],
]

const SELLER_SIGNALS: Array<[string, RegExp]> = [
  [
    'sell a home',
    /\b(?:sell|selling) (?:a|my|our|the)? ?(?:[a-z]+ ){0,2}(?:home|house|condo|townhome|property)\b|\b(?:home|house|property) (?:sale|seller)\b|\bhome ?sellers?\b/i,
  ],
  ['buyer and seller audience', /\bbuyers? (?:and|or) sellers?\b/i],
  ['listing a home', /\blist(?:ing)? (?:a|my|our|the)? ?(?:home|house|property)\b/i],
  ['home value', /\b(?:home value|home valuation|house worth|home worth|pricing my home)\b/i],
  ['pricing a home', /\bpric(?:e|ing) (?:a|my|our|the)? ?(?:home|house|property)\b/i],
  ['prepare to sell', /\b(?:prepare|preparing|stage|staging|renovat(?:e|ing)) (?:a|my|our|the)? ?(?:home|house|property)? ?(?:to|for)? ?(?:sell|sale|listing)\b/i],
  ['downsizing', /\bdownsiz(?:e|ing)\b/i],
]

const LOCAL_AUDIENCE_SIGNALS: Array<[string, RegExp]> = [
  ['neighborhood community', /\b(?:neighbou?rhood|community|local residents?|homeowners?)\b/i],
  [
    'residential owner association',
    /\b(?:homeowners?|property owners?|residents?)\s+(?:association|organization)\b|\b(?:hoa|poa)\s+(?:meeting|community|association)\b/i,
  ],
  ['housing discussion', /\b(?:housing|homes?|real estate) (?:discussion|forum|group|community|questions?|workshop|seminar|event)\b/i],
  ['local event', /\b(?:local|community) (?:event|workshop|seminar|meetup|open house)\b/i],
  ['area guide', /\b(?:relocation|neighbou?rhood|city|area) (?:guide|questions?|discussion|group)\b/i],
]

const REALTOR_NOISE: Array<[string, RegExp]> = [
  [
    'property_listing_inventory',
    /\b(?:mls\s*#?|listed at|listed for \$[\d,.]+|for sale at|luxury home for sale|new listing|just listed|price reduced|reduced to \$[\d,.]+|open house today|dream home alert|schedule (?:a )?(?:private )?tour|book (?:a )?showing|view (?:all )?(?:homes|properties|listings) for sale)\b|\b\d+\s*(?:bed|beds|br)\b.*\b\d+(?:\.\d+)?\s*(?:bath|baths|ba)\b/i,
  ],
  [
    'agent_recruiting',
    /\b(?:join our brokerage|recruiting (?:real estate )?agents?|real estate agent jobs?|hiring realtors?|grow your real estate career)\b/i,
  ],
  [
    'agent_lead_sales',
    /\b(?:buy real estate leads?|realtor leads? for sale|lead generation for (?:agents?|realtors?)|exclusive seller leads?)\b/i,
  ],
  [
    'generic_real_estate_news',
    /\b(?:real estate news|housing market news|weekly market update|mortgage rates? (?:rose|fell|today)|market report)\b/i,
  ],
  ['real_estate_job', /\b(?:real estate|property) (?:job|career|vacancy|position|employment)\b/i],
  [
    'employment_listing',
    /\b(?:job opening|currently hiring|staffing agency|apply for (?:the|this) (?:job|position)|full[- ]time position|part[- ]time position)\b/i,
  ],
  [
    'rental_or_venue_inventory',
    /\b(?:houses? for rent|entire home in|vacation rental|wedding venue|spa resort|guest house near|book your stay)\b/i,
  ],
  [
    'non_property_home_phrase',
    /\b(?:home[- ]made trailer|home trailer|home contents?|household contents?|sell (?:my|our|the) (?:furniture|collectibles?|trailer))\b/i,
  ],
  [
    'agent_self_promotion',
    /\b(?:i(?:'m| am) (?:a )?(?:realtor|real estate agent|real estate broker|mortgage broker)|contact (?:me|us)|call (?:me|us)|dm (?:me|us)|message (?:me|us)|send (?:me|us) a message|reach out(?: to (?:me|us))?|book (?:a )?(?:call|consultation)|schedule (?:a )?(?:call|consultation)|your local realtor|i help (?:home ?buyers?|home ?sellers?|people buy|people sell)|i work with (?:buyers?|sellers?|investors?|homeowners?)|i hear this question from (?:buyers?|sellers?|homeowners?)|(?:i|we|our team) can help|let (?:me|us) help|follow me)\b|#\w*realtor\b/i,
  ],
  [
    'explicit_realtor_disinterest',
    /\b(?:not looking for|do not (?:want|need)|don(?:'|’)t (?:want|need)|without using) (?:a |an )?(?:realtor|real estate agent|real estate broker|broker)\b/i,
  ],
  [
    'provider_authored_social_promotion',
    /https?:\/\/(?:www\.)?(?:facebook|instagram|threads|x|linkedin)\.com\/[^/\s]*(?:realtor|realty|realestate|mortgage|funding|broker|properties)[^/\s]*\/posts?\b/i,
  ],
  [
    'provider_origin_promotion',
    /\b(?:before (?:my|our) team (?:sends?|shows?|shares?) (?:you )?(?:homes?|listings?)|(?:i(?:'ve| have)|we(?:'ve| have)|my team has|our team has) helped (?:hundreds? of |\d+ )?(?:[a-z]+ )?(?:home ?buyers?|home ?sellers?|buyers?|sellers?)|(?:my|our) (?:buyer|seller|home ?buyer|home ?seller) clients?|(?:buyers?|sellers?) (?:i|we) (?:help|represent|serve|work with)|as (?:a|an) (?:realtor|real estate agent|real estate broker|mortgage broker)|(?:realtor|real estate agent|real estate broker) (?:said|says|explained|advised|told))\b/i,
  ],
  [
    'generic_advice_content',
    /\b(?:\d+|five|six|seven|eight|nine|ten) (?:tips?|things?|steps?|mistakes?|questions?) (?:for|every) (?:home ?buyers?|home ?sellers?)\b|\b(?:buyer|seller) tips?\b|\b(?:thinking about selling your home|how much is your home worth|if i were buying (?:a|my) first home|home ?buyer(?:'s)? guide|buyers? aren(?:'|’)t just looking|questions worth answering before (?:you )?(?:buy|sell))\b/i,
  ],
  [
    'marketing_case_study',
    /\b(?:case stud(?:y|ies)|cost per (?:lead|acquisition)|conversion rate|ad spend|google ads|ppc(?: marketing)?|campaign (?:period|performance|optimization)|qualified (?:buyer|seller) leads?|generate more (?:buyer|seller) leads?|high[- ]intent (?:buyer|seller) leads?|real estate (?:seo|marketing|advertising) (?:agency|specialist|campaign))\b/i,
  ],
  [
    'completed_listing_promotion',
    /\b(?:successfully\s+(?:listed\s*(?:&|and)\s*)?sold|(?:just|recently)\s+sold\s*(?::|!|\bthis\s+(?:beautiful\s+)?(?:home|property|listing)\b)|sold\s+(?:this|another)\s+(?:beautiful\s+)?(?:home|property|listing)|another\s+(?:beautiful\s+)?home\s+(?:successfully\s+)?(?:listed\s*(?:&|and)\s*)?sold)\b/i,
  ],
  [
    'completed_buyer_transaction',
    /\b(?:got|received) (?:the|my|our) keys\b|\bfinally did it\b.{0,100}\b(?:home|house|keys|closed|mortgage|\$[\d,.]+)\b|\b(?:just|recently) bought (?:a|my|our|the) (?:home|house|condo|townhome|property)\b|\bclosed on (?:a|my|our|the) (?:home|house|condo|townhome|property)\b/i,
  ],
  [
    'client_success_promotion',
    /\b(?:clear to close|milestone worth celebrating|incredible transactions?|amazing clients?|closing table|client success|seller(?:'|’)s home|buyer(?:'|’)s agent|listing agent|sold for \$?[\d,.]+ (?:over|above) asking)\b/i,
  ],
  [
    'professional_networking',
    /\b(?:let(?:'|’)s connect (?:tampa )?professionals?|real estate professionals? (?:network|meetup)|realtor networking|broker networking)\b/i,
  ],
  [
    'agent_business_development_event',
    /\b(?:realtors?|real estate agents?|real estate professionals?|brokers?|lenders?|mortgage professionals?)\b.{0,220}\b(?:boost (?:your|their|our) brand visibility|showcase (?:your|their|our) expertise|connect with (?:peers|prospective clients?)|build (?:your|their|our) referral network|realtor connect(?: series)?|real estate networking|bonus commission)\b|\b(?:boost (?:your|their|our) brand visibility|showcase (?:your|their|our) expertise|connect with (?:peers|prospective clients?)|build (?:your|their|our) referral network|realtor connect(?: series)?|real estate networking|bonus commission)\b.{0,220}\b(?:realtors?|real estate agents?|real estate professionals?|brokers?|lenders?|mortgage professionals?)\b|\b(?:built|created|designed) (?:specifically |exclusively )?for (?:real estate )?(?:agents?|realtors?|brokers?|lenders?|mortgage professionals?)\b|\b(?:bonus )?commission (?:voucher|giveaway|incentive)\b/i,
  ],
  [
    'market_lifestyle_promotion',
    /\b(?:wallethub|ranked?|ranking|study|report)\b.{0,240}\b(?:cities?|real estate|housing|relocat(?:e|ing|ion)|rental listings?)\b|\b(?:but there(?:'|’)s a bigger real estate story|when people relocate, they aren(?:'|’)t simply choosing)\b/i,
  ],
  [
    'non_owner_or_solicitation_mismatch',
    /\b(?:i (?:lease|rent) (?:and|so) (?:do not|don(?:'|’)t) own|i(?:'m| am) not (?:the )?homeowner|not (?:the )?(?:owner|homeowner)|tips? to deter solicitors|stop (?:door[- ]to[- ]door )?salespeople)\b/i,
  ],
  [
    'tenant_or_rental_dispute',
    /\b(?:lease assignment|early (?:lease )?termination|end(?:ing)? (?:our|my|the) lease|property management company|apartment (?:was )?flooded|charged .*?(?:running toilet|water damage)|landlord (?:dispute|complaint)|security deposit dispute)\b/i,
  ],
  [
    'rental_or_lifestyle_intent',
    /\b(?:looking for|want(?:ing)?|need(?:ing)?|move|moving|relocat(?:e|ing))\b.{0,100}\b(?:apartment|rental|renting|lease)\b|\b(?:apartment|rental) (?:search|hunt|recommendation)\b/i,
  ],
  [
    'service_directory_or_marketplace',
    /\b(?:visit (?:the )?marketplace|marketplace by|directory of (?:local )?(?:service )?(?:professionals?|providers?|businesses?)|list of trusted [a-z -]{0,50}(?:professionals?|providers?|pros)|browse (?:local )?(?:service )?(?:professionals?|providers?|pros))\b/i,
  ],
  [
    'search_or_event_aggregation_page',
    /\b(?:events and things to do|search results? (?:for|page)|browse (?:all )?(?:upcoming )?events|primary image\b.{0,180}\bprimary image)\b/i,
  ],
  [
    'real_estate_testimonial_or_investor_promotion',
    /\b(?:couldn(?:'|’)t have asked for (?:a )?better.{0,120}(?:realtor|real estate agent)|first[- ]class realtor|trusted,? no[- ]hassle cash home buyer|we buy houses|sell your (?:home|house) for cash)\b/i,
  ],
  [
    'cash_buyer_or_commission_avoidance_promotion',
    /\blooking to sell your (?:home|house|property)\b/i,
  ],
  [
    'source_spam_or_adult_content',
    /\b(?:shieldsquare captcha|captcha (?:challenge|page)|stockton on tees escorts?|adult escorts?|escort services?|adult entertainment|sex dating|casino bonus|online gambling)\b/i,
  ],
  [
    'sensitive_personal_crisis',
    /\b(?:passed away|passed last month|bereav(?:ed|ement)|grieving|late (?:sister|brother|mother|father|parent|spouse|partner)|below the poverty line|financial hardship|medical crisis)\b/i,
  ],
]

const SENSITIVE_CONSUMER_OPPORTUNITY: Array<[string, RegExp]> = [
  [
    'sensitive_health_or_disability',
    /\b(?:disab(?:led|ility)|medical (?:condition|crisis|debt|issue|issues|symptom|symptoms)|health (?:condition|problem|problems|issue|issues)|hair loss|chronic illness|cancer diagnosis|mental health|pregnan(?:t|cy)|substance (?:use|abuse)|addiction|opioid|overdose|sober living|recovery (?:home|house|housing))\b/i,
  ],
  [
    'sensitive_housing_instability',
    /\b(?:homeless(?:ness)?|unhoused|housing (?:insecurity|instability)|no place to stay|sleeping (?:in|on) (?:my|a) (?:car|couch)|couch surf(?:ing)?|about to be evicted|being evicted|cannot pay (?:my )?rent|can(?:'|’)t pay (?:my )?rent|predatory landlord|domestic violence|abuse survivor)\b/i,
  ],
  [
    'sensitive_minor_or_protected_trait',
    /\b(?:minor|underage|child(?:ren)?(?:'s)? housing|sex offender|sexual orientation|gender identity|immigration status|citizenship status|racial identity|ethnic identity|religious affiliation)\b|\b(?:i|we)(?:'m|'re| am| are)\s+(?:a\s+)?(?:parent|mother|father|mom|dad)\b|\b(?:my|our|we have|with (?:my|our))\s+(?:an?\s+)?(?:baby|babies|child|children|kid|kids|toddler|toddlers|teen|teens|teenager|teenagers)\b/i,
  ],
  [
    'sensitive_bereavement_or_financial_distress',
    /\b(?:passed away|bereav(?:ed|ement)|grieving|late (?:sister|brother|mother|father|parent|spouse|partner)|below the poverty line|bankrupt(?:cy)?|foreclos(?:e|ed|ure)|tax delinquen(?:t|cy)|financial hardship)\b|\bincome\b.{0,36}\b(?:is\s+)?(?:not|isn(?:'|’)t|wasn(?:'|’)t)\s+enough\b|\b(?:banks?|lenders?)\b.{0,80}\b(?:turn(?:ed)?\s+(?:me|us|it|my|our)?\s*down|declin(?:e|ed)|reject(?:ed)?)\b|\b(?:loan|mortgage|credit|refinanc(?:e|ing)|equity)\b.{0,48}\b(?:denied|declined|rejected|turned down)\b|\b(?:couldn(?:'|’)t|cannot|can(?:'|’)t|unable to)\b.{0,48}\b(?:take|access|tap)\b.{0,24}\bequity\b/i,
  ],
  [
    'sensitive_age_or_marital_status',
    /\b(?:senior citizens?|elderly|older adults?|widow(?:ed|er)?|marital status)\b|\b(?:i am|i(?:'|’)m|we are|we(?:'|’)re)\s+(?:(?:single|married|divorced|widowed)\s+(?:and\s+)?)?(?:a\s+)?senior\b(?!\s+(?:vice|director|manager|engineer|executive|associate|analyst|officer|counsel|partner|leader|developer))\b/i,
  ],
]

const HISTORICAL_COMPLETED_PROPERTY_TRANSACTION =
  /\b(?:bought|purchased|sold|buy(?:ing)?|sell(?:ing)?)\b.{0,180}\b(?:\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|twenty)\s+years?\s+ago\b|\b(?:\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|twenty)\s+years?\s+ago\b.{0,180}\b(?:bought|purchased|sold|buy(?:ing)?|sell(?:ing)?)\b/i
// Recent search results can still describe a transaction that is already in
// the past (for example, "I was selling a home and needed appliances"). The
// publication date alone cannot turn that historical anecdote into current
// demand. Keep the pattern first-person and residential, then allow an
// explicit present decision below to override it.
const HISTORICAL_PAST_TENSE_PROPERTY_TRANSACTION =
  /\b(?:(?:i|we)\s+(?:was|were)\s+(?:buying|purchasing|selling|listing)\s+(?:(?:a|my|our|the|this)\s+)?(?:home|house|condo|townhome|property)|when\s+(?:i|we)\s+(?:bought|purchased|sold|listed)\s+(?:(?:a|my|our|the|this)\s+)?(?:home|house|condo|townhome|property))\b/i
const CURRENT_PROPERTY_DECISION_AFTER_HISTORY =
  /\b(?:now|currently|today|this (?:month|year))\b.{0,180}\b(?:buy|buying|purchase|purchasing|sell|selling|list|listing|move|moving|refinance|refinancing)\b/i

// Some genuine residential-location questions omit the object after “buy”
// because the surrounding question makes it clear (for example, “we are
// looking to buy but not get too far out; what is the neighborhood like?”).
// Keep this deliberately narrower than a bare `looking to buy` match so a
// product purchase, ticket request, or collectible search cannot become a
// housing lead merely because it was returned by a realtor-oriented query.
const FIRST_PERSON_BUY_WITH_RESIDENTIAL_LOCATION_DECISION =
  /\b(?:i|we)(?:(?:'m|'re| am| are)|(?:'ve| have)(?: been)?)?\s+(?:actively\s+)?(?:looking|trying|planning|hoping|wanting)\s+to\s+(?:buy|purchase)\b(?=.{0,160}\b(?:not (?:get|go|move) too far|what(?:'|’)s the vibe|family[- ]friendly|school districts?|commute|neighbou?rhoods?|areas? (?:to|should|would)|where (?:should|could) (?:i|we) live)\b)/i
const FIRST_PERSON_BARE_BUY_INTENT =
  /\b(?:i|we)(?:(?:'m|'re| am| are)|(?:'ve| have)(?: been)?)?\s+(?:actively\s+)?(?:looking|trying|planning|hoping|wanting)\s+to\s+(?:buy|purchase)\b/i
const LOCAL_RESIDENTIAL_DECISION_QUESTION =
  /\b(?:what(?:'|’)s the scoop on|what(?:'|’)s the vibe(?: in| around| near| of)?|thoughts on|how is|how(?:'|’)s|would you recommend)\b.{0,100}\??/i
const ENTERTAINMENT_HOUSE_SEARCH =
  /\b(?:tv|television|show|series|episode|channel|watch(?:ed|ing)?)\b.{0,120}\b(?:house hunt(?:ing)?|home remodel(?:ing)?|home renovation)\b|\b(?:house hunt(?:ing)?|home remodel(?:ing)?|home renovation)\b.{0,120}\b(?:tv|television|show|series|episode|channel|watch(?:ed|ing)?)\b/i
const REALTOR_HOUSING_CONTEXT =
  /\b(?:houses?|housing|propert(?:y|ies)|condos?|townhomes?|homeowners?|home ?buyers?|home ?sellers?|first[- ]time buyers?|mortgage|down payment|closing costs?|real estate|neighbou?rhood association|homeowners? association|community association|community registry|neighbou?rhood college|homebuyer education)\b|\b(?:buy|buying|purchase|purchasing|sell|selling|list|listing|price|pricing|prepare|preparing)\b.{0,60}\bhome\b/i
const CONSUMER_QUESTION =
  /\b(?:(?:does|can|could|would|has|is) anyone|(?:where|what|which|how|should|can|could|would|do|does|has|have|is|are) (?:i|we)|(?:where|what|which|how) should (?:i|we|my|our)\b|i(?:'m| am) ask(?:ing)?|we(?:'re| are) ask(?:ing)?|need (?:some )?help|looking for (?:advice|help|recommendations?)|recommendations? (?:for|on|about)|(?:would|could) love (?:your|some|any)?\s*suggestions?|suggestions? (?:for|on|about))\b/i
const FIRST_PERSON_HOUSING_NEED =
  /\b(?:i|we)(?:'m|'re| am| are|(?:'ve| have)(?: been)?)?\s+(?:actively\s+)?(?:(?:thinking (?:about|of)|considering)\s+(?:buying|purchasing|selling|listing|moving|relocating)\b|(?:planning|preparing|trying|looking|waiting|hoping|needing|wanting)\s+to\s+(?:buy|purchase|sell|list|move|relocate)\b|(?:planning|preparing|trying|looking|waiting|hoping|needing|wanting)\s+to\s+find\s+(?:(?:a|my|our|the)\s+)?(?:home|house|condo|townhome|property)\b|(?:looking|searching)\s+for\s+(?:a\s+)?(?:home|house|condo|townhome|property|realtor|real estate agent)\b)/i
// Short social captions often omit the subject while still describing the
// author's current activity (for example, "Way too early house hunting in
// Austin"). Accept only that narrow declaration or an explicit first-person
// form. Agent CTAs, listing inventory, generic advice, completed transactions,
// and query text remain excluded by the independent noise and evidence gates.
const CURRENT_HOUSE_HUNTING_DECLARATION =
  /\b(?:(?:i|we)(?:'m|'re| am| are)\s+(?:actively\s+)?house hunting\s+(?:in|around|near)\b|way\s+too?\s+early\s+house hunting\s+(?:in|around|near)\b)/i
// People often describe the beginning of a housing search as a plan rather
// than a current state (for example, "my husband and I are looking to start
// house hunting"). Keep the subject first-person and the action explicitly
// residential so provider promotion and generic uses of "looking" remain out.
const FIRST_PERSON_HOUSE_HUNTING_PLAN =
  /\b(?:i|we|(?:(?:my|our)\s+)?(?:husband|wife|spouse|partner)\s+and\s+i)(?:'m|'re| am| are)\s+(?:actively\s+)?(?:looking|planning|hoping|wanting|ready)\s+to\s+(?:start|begin)\s+house hunting\b/i
// Some current buyers describe the beginning of their search as “starting to
// look at buying” and name neighborhoods, commute, affordability, or housing
// in the following text. Requiring both first-person onset language and nearby
// residential context keeps product purchases and provider-authored content
// out while preserving genuine local housing questions returned by Reddit.
const FIRST_PERSON_STARTING_RESIDENTIAL_PURCHASE_SEARCH =
  /\b(?:i|we)(?:['’]m|['’]re| am| are)\s+(?:just\s+)?(?:starting|beginning)\s+to\s+(?:look at|consider)\s+(?:buying|purchasing)\b(?=[\s\S]{0,600}\b(?:homes?|houses?|condos?|townhomes?|propert(?:y|ies)|neighbou?rhoods?)\b)/i
const DIRECT_HOUSING_TRANSACTION_NEED =
  /\b(?:looking|trying|planning|hoping|wanting|waiting|preparing|needing)\s+to\s+(?:buy|purchase|sell|list)\s+(?:(?:a|my|our|the|this)\s+)?(?:home|house|condo|townhome|property)\b|\b(?:looking|searching)\s+for\s+(?:a\s+)?(?:home|house|condo|townhome|property|realtor|real estate agent)\b/i
const DIRECT_BUYER_TRANSACTION_NEED =
  /\b(?:looking|trying|planning|hoping|wanting|waiting|preparing|needing)\s+to\s+(?:buy|purchase)\s+(?:(?:a|my|our|the|this)\s+)?(?:(?:first|current|next|new|smaller|larger)\s+)?(?:home|house|condo|townhome|property)\b|\b(?:looking|searching)\s+for\s+(?:a\s+)?(?:home|house|condo|townhome|property)\b|\b(?:and|then)\s+(?:buy|purchase)\s+(?:(?:a|my|our|the|this)\s+)?(?:(?:first|current|next|new|smaller|larger)\s+)?(?:home|house|condo|townhome|property)\b/i
const DIRECT_SELLER_TRANSACTION_NEED =
  /\b(?:looking|trying|planning|hoping|wanting|waiting|preparing|needing)\s+to\s+(?:sell|list)\s+(?:(?:a|my|our|the|this)\s+)?(?:home|house|condo|townhome|property)\b/i
const FIRST_PERSON_DIRECT_HOUSING_TRANSACTION =
  /\b(?:i|we)(?:'m|'re| am| are)\s+(?:actively\s+)?(?:buying|purchasing|selling|listing)\s+(?:(?:a|my|our|the)\s+)?(?:home|house|condo|townhome|property)\b/i
const FIRST_PERSON_TRANSACTION_PROGRESS =
  /\b(?:(?:i|we)(?:'ve| have)?\s+(?:made|submitted|placed|put in)\s+(?:(?:an?|the|my|our)\s+)?offer|(?:my|our)\s+(?:offer|counteroffer|mortgage|pre[- ]?approval|appraisal|inspection|closing costs?)\b|(?:seller|buyer)\s+(?:accepted|rejected|countered)\s+(?:my|our)\s+offer)\b/i
const DEMONSTRATED_HOUSING_STATUS =
  /\b(?:first[- ]time (?:home )?buyer|homeowner|home buyer|home seller)\s+(?:moving|looking|planning|preparing|trying|considering|thinking|needing|wanting)\b/i
const FIRST_PERSON_HOUSING_IDENTITY =
  /\b(?:i|we)(?:'m|'re| am| are)\s+(?:a\s+)?(?:first[- ]time (?:home )?buyers?|homeowners?|home buyers?|home sellers?)\b/i
// Current consumer language is not limited to "planning to sell." Real
// conversations often use imminent intent ("can't wait to sell my house") or
// refer back to a very recent public request ("I posted about selling my
// house recently"). Keep these forms first-person and residential so generic
// seller articles, agent CTAs, and unrelated product sales cannot qualify.
const FIRST_PERSON_IMMINENT_HOUSING_TRANSACTION =
  /\b(?:(?:i|we)(?:'m|'re| am| are)?\s+(?:(?:about|ready|going)\s+to|(?:can(?:not|'t)|could(?: not|n't))\s+wait\s+to)\s+(?:buy|purchase|sell|list)\s+(?:(?:a|my|our|the|this)\s+)?(?:home|house|condo|townhome|property)|can(?:not|'t)\s+wait\s+to\s+(?:buy|purchase|sell|list)\s+(?:my|our)\s+(?:home|house|condo|townhome|property))\b/i
const FIRST_PERSON_RECENT_HOUSING_REQUEST =
  /\b(?:i|we)(?:'ve| have)?\s+(?:(?:recently|just)\s+)?(?:posted|asked|wrote|talked)\s+about\s+(?:buying|purchasing|selling|listing)\s+(?:(?:a|my|our|the|this)\s+)?(?:home|house|condo|townhome|property)(?:\s+recently)?\b/i
// Directly asking the public for an agent recommendation is itself a
// consumer request for transaction help. This deliberately requires an
// assistance verb plus an agent role; a provider-authored post that merely
// mentions a realtor still fails, and the independent promotion/noise rules
// continue to reject solicitation copy.
const DIRECT_REALTOR_ASSISTANCE_REQUEST =
  /\b(?:(?:looking|searching) for|need(?:ing)?|seek(?:ing)?|want(?:ing)?|recommend(?:ation)?s? (?:for|on)|can (?:anyone|somebody) recommend|does (?:anyone|somebody) (?:know|recommend))\b.{0,80}\b(?:realtor|real estate agent|listing agent|buyer(?:'|’)s agent)\b|\b(?:realtor|real estate agent|listing agent|buyer(?:'|’)s agent)\s+recommendations?\b/i
const PARTICIPATION_SURFACE =
  /\b(?:community|forum|group|thread|discussion|question|event|workshop|seminar|webinar|class|meetup|panel|association|club|neighbou?rhood|homeowners?)\b/i
const EDUCATIONAL_EVENT = /\b(?:event|fair|workshop|seminar|webinar|class|meetup|panel|clinic|q\s*&\s*a)\b/i
const VENUE_CONSUMER_DEMAND =
  /\b(?:people|homeowners?|home ?buyers?|home ?sellers?|buyers?|sellers?)\s+(?:ask(?:ing)?|seek(?:ing)?|look(?:ing)?|discuss(?:ing)?|consider(?:ing)?|plan(?:ning)?|prepar(?:ing)?|need(?:ing)?)\b|\b(?:buyer|seller|homeowner|homebuying|home[- ]selling|first[- ]home) questions?\b/i
const PUBLIC_PARTICIPATION_EVIDENCE =
  /\b(?:join(?:ing)?|membership|members?|meetings?|calendar|upcoming events?|get involved|volunteer|register|attend|discussion|questions?|forum|community conversation|community registry|community groups?|community organizations?|resident organizations?|public workshop|public seminar|neighbou?rhood college)\b/i
const INACTIVE_DESTINATION =
  /\b(?:no upcoming events?|no events? (?:are )?scheduled|event (?:has )?ended|event is over|this event has passed|past event|registration (?:is )?closed|registration unavailable|sold out|event (?:was )?cancelled|event (?:was )?canceled|not currently scheduled|workshop unavailable|page not found|content unavailable)\b/i
const MONTHS =
  '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)'

const US_STATE_NAMES = [
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware',
  'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky',
  'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi',
  'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey', 'new mexico',
  'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania',
  'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont',
  'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming',
] as const

const US_STATE_ABBREVIATIONS: Record<string, (typeof US_STATE_NAMES)[number] | 'district of columbia'> = {
  al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california', co: 'colorado',
  ct: 'connecticut', de: 'delaware', dc: 'district of columbia', fl: 'florida', ga: 'georgia',
  hi: 'hawaii', id: 'idaho', il: 'illinois', in: 'indiana', ia: 'iowa', ks: 'kansas',
  ky: 'kentucky', la: 'louisiana', me: 'maine', md: 'maryland', ma: 'massachusetts',
  mi: 'michigan', mn: 'minnesota', ms: 'mississippi', mo: 'missouri', mt: 'montana',
  ne: 'nebraska', nv: 'nevada', nh: 'new hampshire', nj: 'new jersey', nm: 'new mexico',
  ny: 'new york', nc: 'north carolina', nd: 'north dakota', oh: 'ohio', ok: 'oklahoma',
  or: 'oregon', pa: 'pennsylvania', ri: 'rhode island', sc: 'south carolina',
  sd: 'south dakota', tn: 'tennessee', tx: 'texas', ut: 'utah', vt: 'vermont',
  va: 'virginia', wa: 'washington', wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming',
}

const TRACKING_PARAMETER = /^(?:utm_.+|fbclid|gclid|dclid|msclkid|mc_[ce]id|trk|trackingId|ref_src)$/i
const NON_LOCAL_REDDIT_COMMUNITIES = new Set([
  'realestate',
  'realestateinvesting',
  'firsttimehomebuyer',
  'homeowners',
  'homeimprovement',
  'personalfinance',
  'mortgages',
  'housing',
  'realtors',
])

function matchedSignals(content: string, definitions: Array<[string, RegExp]>): string[] {
  return definitions.filter(([, pattern]) => pattern.test(content)).map(([label]) => label)
}

/**
 * Classifies only returned content. Search terms, provider targeting, and a
 * caller-supplied label are deliberately absent from this signature so they
 * cannot become evidence by accident.
 */
function classifyOpportunityIntentWithContract(
  content: string,
  includeResidentialLocationDecision: boolean,
  excludeEntertainmentHouseSearch: boolean,
): OpportunityIntentClassification {
  const matchedBuyerSignals = matchedSignals(content, BUYER_SIGNALS).filter(
    (signal) => !(
      excludeEntertainmentHouseSearch
      && signal === 'home search'
      && ENTERTAINMENT_HOUSE_SEARCH.test(content)
    ),
  )
  const buyerSignals = [
    ...matchedBuyerSignals,
    ...(includeResidentialLocationDecision
      && FIRST_PERSON_BUY_WITH_RESIDENTIAL_LOCATION_DECISION.test(content)
      ? ['residential location decision']
      : []),
  ]
  const sellerSignals = matchedSignals(content, SELLER_SIGNALS)
  const localAudienceSignals = matchedSignals(content, LOCAL_AUDIENCE_SIGNALS)
  const kind: DemonstratedOpportunityIntent =
    buyerSignals.length > 0 && sellerSignals.length > 0
      ? 'mixed_intent'
      : buyerSignals.length > 0
        ? 'buyer_intent'
        : sellerSignals.length > 0
          ? 'seller_intent'
          : localAudienceSignals.length > 0
            ? 'local_audience'
            : null
  const strongest = Math.max(buyerSignals.length, sellerSignals.length, localAudienceSignals.length)
  const confidence = kind == null ? 0 : Math.min(0.95, 0.56 + Math.max(0, strongest - 1) * 0.1)
  return { kind, buyerSignals, sellerSignals, localAudienceSignals, confidence }
}

/** Preserves the exact content classifier used by already-quoted v1 plans. */
export function classifyOpportunityIntentV1(content: string): OpportunityIntentClassification {
  return classifyOpportunityIntentWithContract(content, false, false)
}

/** Preserves the exact content classifier used by already-quoted v2 plans. */
export function classifyOpportunityIntentV2(content: string): OpportunityIntentClassification {
  return classifyOpportunityIntentWithContract(content, true, false)
}

/** Preserves the exact content classifier used by already-quoted v3 plans. */
export function classifyOpportunityIntentV3(content: string): OpportunityIntentClassification {
  const classified = classifyOpportunityIntentWithContract(content, true, true)
  const directBuyer = DIRECT_BUYER_TRANSACTION_NEED.test(content)
  const directSeller = DIRECT_SELLER_TRANSACTION_NEED.test(content)
  const kind = directBuyer === directSeller
    ? classified.kind
    : directBuyer
      ? 'buyer_intent'
      : 'seller_intent'
  return { ...classified, kind }
}

/** Current returned-content classifier. */
export function classifyOpportunityIntent(content: string): OpportunityIntentClassification {
  const classified = classifyOpportunityIntentV3(content)
  if (!FIRST_PERSON_STARTING_RESIDENTIAL_PURCHASE_SEARCH.test(content)) return classified
  const buyerSignals = classified.buyerSignals.includes('starting residential purchase search')
    ? classified.buyerSignals
    : [...classified.buyerSignals, 'starting residential purchase search']
  const kind = classified.kind === 'seller_intent' || classified.kind === 'mixed_intent'
    ? 'mixed_intent'
    : 'buyer_intent'
  return {
    ...classified,
    kind,
    buyerSignals,
    confidence: Math.max(classified.confidence, 0.66),
  }
}

function localRedditCommunity(sourceUrl: string | null): boolean {
  if (!sourceUrl) return false
  try {
    const url = new URL(sourceUrl)
    const host = url.hostname.toLowerCase()
    if (host !== 'reddit.com' && !host.endsWith('.reddit.com')) return false
    const subreddit = normalizedLocationToken(url.pathname.match(/^\/r\/([^/]+)/i)?.[1] ?? '')
    return Boolean(subreddit) && !NON_LOCAL_REDDIT_COMMUNITIES.has(subreddit)
  } catch {
    return false
  }
}

/**
 * Adds only destination-grounded context to the returned-content classifier.
 * A first-person bare purchase phrase is ambiguous by itself, but a locality
 * question inside a place-specific public Reddit community proves a
 * residential-location decision even when the provider truncates the words
 * after `buy`. Topic-wide communities and provider query text never qualify.
 */
export function classifyOpportunityIntentAtDestination(
  content: string,
  sourceUrl: string | null,
): OpportunityIntentClassification {
  const classified = classifyOpportunityIntent(content)
  if (
    classified.kind != null
    || !localRedditCommunity(sourceUrl)
    || !FIRST_PERSON_BARE_BUY_INTENT.test(content)
    || !LOCAL_RESIDENTIAL_DECISION_QUESTION.test(content)
  ) {
    return classified
  }
  return {
    ...classified,
    kind: 'buyer_intent',
    buyerSignals: [...classified.buyerSignals, 'local residential purchase question'],
    confidence: Math.max(classified.confidence, 0.66),
  }
}

export function realtorOpportunityNoiseReasons(content: string, sourceUrl: string | null = null): string[] {
  const material = `${content}\n${sourceUrl ?? ''}`
  const historicalTransaction = (
    HISTORICAL_COMPLETED_PROPERTY_TRANSACTION.test(material)
    || HISTORICAL_PAST_TENSE_PROPERTY_TRANSACTION.test(material)
  )
    && !CURRENT_PROPERTY_DECISION_AFTER_HISTORY.test(material)
    ? ['historical_completed_transaction']
    : []
  return [
    ...REALTOR_NOISE.filter(([, pattern]) => pattern.test(material)).map(([reason]) => reason),
    ...sensitiveConsumerOpportunityReasons(material),
    ...historicalTransaction,
  ].filter((reason, index, reasons) => reasons.indexOf(reason) === index)
}

/**
 * Returns only evidence-grounded safety reasons found in provider-returned
 * content. Search targeting is deliberately not accepted as proof here.
 */
export function sensitiveConsumerOpportunityReasons(content: string): string[] {
  return SENSITIVE_CONSUMER_OPPORTUNITY
    .filter(([, pattern]) => pattern.test(content))
    .map(([reason]) => reason)
}

function normalizedPhrase(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stateNamesIn(value: string, primaryLocation?: string | null): Set<string> {
  const normalized = ` ${normalizedPhrase(value)} `
  const states = new Set<string>(
    US_STATE_NAMES.filter((state) => normalized.includes(` ${state} `)),
  )
  if (normalized.includes(' district of columbia ')) states.add('district of columbia')

  // Postal abbreviations in source material are expected to use their normal
  // uppercase form. Case-insensitive matching turns ordinary prose such as
  // “agents, brokers, or lenders” into a false Oregon contradiction.
  const abbreviationPatterns = [/,\s*([A-Z]{2})(?=\b)/g]
  const primary = primaryLocation?.trim()
  if (primary) {
    abbreviationPatterns.push(
      new RegExp(`\\b${escapeRegExp(primary)}(?:\\s*,\\s*|\\s+)([A-Z]{2})(?=\\b)`, 'g'),
    )
  }
  for (const pattern of abbreviationPatterns) {
    for (const match of value.matchAll(pattern)) {
      const state = US_STATE_ABBREVIATIONS[(match[1] ?? '').toLowerCase()]
      if (state) states.add(state)
    }
  }
  return states
}

/**
 * Returns the requested locality only when the returned provider material
 * independently contains its most-specific place name. The requested search
 * location itself is targeting provenance and cannot prove geography.
 */
export function demonstratedOpportunityLocation(
  returnedMaterial: string,
  requestedLocation: string | null | undefined,
): string | null {
  const requested = requestedLocation?.trim().replace(/\s+/g, ' ')
  if (!requested) return null
  const primary = requested.split(',')[0]?.trim()
  if (!primary) return null
  const material = ` ${normalizedPhrase(returnedMaterial)} `
  const target = normalizedPhrase(primary)
  if (!target || !material.includes(` ${target} `)) return null
  if (opportunityHasContradictoryUsState(returnedMaterial, requested)) return null
  return requested
}

export function opportunityHasContradictoryUsState(
  returnedMaterial: string,
  expectedGeography: string,
): boolean {
  const primary = expectedGeography.split(',')[0]?.trim() ?? null
  const expectedStates = stateNamesIn(expectedGeography, primary)
  if (expectedStates.size === 0) return false
  const observedStates = stateNamesIn(returnedMaterial, primary)
  return observedStates.size > 0 && [...observedStates].every((state) => !expectedStates.has(state))
}

function normalizedLocationToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * A local subreddit is part of the returned destination, not query targeting.
 * If it names a different market, a snippet mention of the requested city
 * cannot manufacture locality (for example, r/chicagoapartments mentioning
 * Austin only as a comparison).
 */
export function publicSourceGeographyConflict(
  sourceUrl: string | null,
  expectedGeographies: string[],
  returnedMaterial = '',
): string | null {
  if (!sourceUrl || expectedGeographies.length === 0) return null
  try {
    const url = new URL(sourceUrl)
    if (!url.hostname.toLowerCase().endsWith('reddit.com')) return null
    const subreddit = url.pathname.match(/^\/r\/([^/]+)/i)?.[1]
    if (!subreddit) return null
    const returned = normalizedLocationToken(subreddit)
    if (!returned || NON_LOCAL_REDDIT_COMMUNITIES.has(returned)) return null
    const expectedTokens = expectedGeographies
      .flatMap((value) => value.split(','))
      .map(normalizedLocationToken)
      .filter((value) => value.length >= 3 && !['unitedstates', 'usa'].includes(value))
    if (expectedTokens.some((value) => returned.includes(value) || value.includes(returned))) return null
    // A destination-local community is stronger geography evidence than a
    // stray target-city mention in a title or snippet. When the returned
    // material independently uses the subreddit name in a housing/locality
    // context, treat a different community as contradictory. Topic-only
    // communities are allowlisted above and remain non-local.
    const subredditPhrase = normalizedPhrase(subreddit)
    if (subredditPhrase && returnedMaterial.trim()) {
      const localCommunityPattern = new RegExp(
        `(?:\\b(?:home|house|housing|property|neighbou?rhood|city|local)\\b.{0,60}\\b${escapeRegExp(subredditPhrase)}\\b|\\b${escapeRegExp(subredditPhrase)}\\b.{0,60}\\b(?:home|house|housing|property|neighbou?rhood|city|local)\\b)`,
        'i',
      )
      if (localCommunityPattern.test(normalizedPhrase(returnedMaterial))) {
        return `reddit:r/${subreddit}`
      }
    }
    // Do not guess that every arbitrary subreddit name is a place. Only treat
    // a non-matching subreddit as contradictory when its returned name itself
    // carries a local-market form. This preserves national/topic communities
    // while catching the observed r/chicagoapartments class.
    if (!/(?:apartments?|rentals?|local|locals|metro|city|realestate|housing)$/.test(returned)) return null
    return `reddit:r/${subreddit}`
  } catch {
    return null
  }
}

/**
 * Returns a requested locality only when the returned Reddit destination is
 * itself an exact local-community form for that market. This is source
 * evidence, not query targeting: broad topic subreddits remain unknown, and
 * non-matching local communities are handled by publicSourceGeographyConflict.
 */
export function demonstratedPublicSourceGeography(
  sourceUrl: string | null,
  expectedGeographies: string[],
): string | null {
  if (!sourceUrl || expectedGeographies.length === 0) return null
  try {
    const url = new URL(sourceUrl)
    if (!url.hostname.toLowerCase().endsWith('reddit.com')) return null
    const subreddit = url.pathname.match(/^\/r\/([^/]+)/i)?.[1]
    if (!subreddit) return null
    const returned = normalizedLocationToken(subreddit)
    if (!returned || NON_LOCAL_REDDIT_COMMUNITIES.has(returned)) return null

    for (const geography of expectedGeographies) {
      const primary = normalizedLocationToken(geography.split(',')[0] ?? '')
      if (primary.length < 3) continue
      const exactLocalForms = new Set([
        primary,
        `ask${primary}`,
        `${primary}homes`,
        `${primary}homeowners`,
        `${primary}housing`,
        `${primary}locals`,
        `${primary}metro`,
        `${primary}realestate`,
      ])
      if (exactLocalForms.has(returned)) return geography
    }
    return null
  } catch {
    return null
  }
}

export type RealtorOpportunitySuitability = {
  relevant: boolean
  demonstratedIntent: DemonstratedOpportunityIntent
  reasons: string[]
}

/**
 * A realtor opportunity must demonstrate a housing context and either a real
 * consumer need/question or a participation surface. Generic agent marketing
 * and educational listicles are not demand, even if they contain buyer/seller
 * words and look complete.
 */
export function assessRealtorOpportunitySuitability(
  content: string,
  expectedIntent: DemonstratedOpportunityIntent,
  sourceUrl: string | null = null,
  opportunityKind: string | null = null,
): RealtorOpportunitySuitability {
  const destinationGroundedBuyer = localRedditCommunity(sourceUrl)
    && FIRST_PERSON_BARE_BUY_INTENT.test(content)
    && LOCAL_RESIDENTIAL_DECISION_QUESTION.test(content)
  const intent = classifyOpportunityIntentAtDestination(content, sourceUrl).kind
  const reasons = realtorOpportunityNoiseReasons(content, sourceUrl)
  const housing =
    REALTOR_HOUSING_CONTEXT.test(content)
    || FIRST_PERSON_BUY_WITH_RESIDENTIAL_LOCATION_DECISION.test(content)
    || FIRST_PERSON_STARTING_RESIDENTIAL_PURCHASE_SEARCH.test(content)
    || destinationGroundedBuyer
  const consumerNeed =
    CONSUMER_QUESTION.test(content)
    || FIRST_PERSON_HOUSING_NEED.test(content)
    || CURRENT_HOUSE_HUNTING_DECLARATION.test(content)
    || FIRST_PERSON_HOUSE_HUNTING_PLAN.test(content)
    || FIRST_PERSON_STARTING_RESIDENTIAL_PURCHASE_SEARCH.test(content)
    || DIRECT_HOUSING_TRANSACTION_NEED.test(content)
    || FIRST_PERSON_DIRECT_HOUSING_TRANSACTION.test(content)
    || FIRST_PERSON_TRANSACTION_PROGRESS.test(content)
    || DEMONSTRATED_HOUSING_STATUS.test(content)
    || FIRST_PERSON_HOUSING_IDENTITY.test(content)
    || FIRST_PERSON_IMMINENT_HOUSING_TRANSACTION.test(content)
    || FIRST_PERSON_RECENT_HOUSING_REQUEST.test(content)
    || DIRECT_REALTOR_ASSISTANCE_REQUEST.test(content)
    || destinationGroundedBuyer
  const directConsumerNeed =
    FIRST_PERSON_HOUSING_NEED.test(content)
    || CURRENT_HOUSE_HUNTING_DECLARATION.test(content)
    || FIRST_PERSON_HOUSE_HUNTING_PLAN.test(content)
    || FIRST_PERSON_STARTING_RESIDENTIAL_PURCHASE_SEARCH.test(content)
    || DIRECT_HOUSING_TRANSACTION_NEED.test(content)
    || FIRST_PERSON_DIRECT_HOUSING_TRANSACTION.test(content)
    || FIRST_PERSON_TRANSACTION_PROGRESS.test(content)
    || DEMONSTRATED_HOUSING_STATUS.test(content)
    || FIRST_PERSON_HOUSING_IDENTITY.test(content)
    || FIRST_PERSON_IMMINENT_HOUSING_TRANSACTION.test(content)
    || FIRST_PERSON_RECENT_HOUSING_REQUEST.test(content)
    || DIRECT_REALTOR_ASSISTANCE_REQUEST.test(content)
    || destinationGroundedBuyer
  const surface = PARTICIPATION_SURFACE.test(content)
  const educationalEvent = EDUCATIONAL_EVENT.test(content)
  const participationVenue = ['community', 'forum', 'group', 'thread'].includes(opportunityKind ?? '')
  const stableParticipationVenue = ['community', 'forum', 'group'].includes(opportunityKind ?? '')
  const transactionIntent = ['buyer_intent', 'seller_intent', 'mixed_intent'].includes(intent ?? '')
  const scheduledEvent = opportunityKind === 'event' && educationalEvent
  const educationalAudienceChannel =
    ['community', 'forum', 'group', 'event'].includes(opportunityKind ?? '')
    && educationalEvent
  const venueConsumerDemand = participationVenue && VENUE_CONSUMER_DEMAND.test(content)
  const laneMatches =
    expectedIntent == null
    || intent === expectedIntent
    || (intent === 'mixed_intent' && (expectedIntent === 'buyer_intent' || expectedIntent === 'seller_intent'))
    || (expectedIntent === 'mixed_intent'
      && (intent === 'buyer_intent' || intent === 'seller_intent' || intent === 'mixed_intent'))
    || (expectedIntent === 'local_audience'
      && (intent === 'buyer_intent' || intent === 'seller_intent' || intent === 'mixed_intent'))
  const localParticipation =
    (stableParticipationVenue && (PUBLIC_PARTICIPATION_EVIDENCE.test(content) || content.includes('?')))
    || scheduledEvent
    || educationalAudienceChannel
    || (opportunityKind === 'post' && surface && directConsumerNeed && transactionIntent)
    || (opportunityKind === 'thread' && consumerNeed && transactionIntent)
  const directDemand = opportunityKind === 'post' ? directConsumerNeed : consumerNeed
  if (!housing) reasons.push('missing_housing_context')
  if (!laneMatches) reasons.push('intent_lane_mismatch')
  if (expectedIntent === 'local_audience' && !localParticipation) reasons.push('missing_consumer_participation')
  if (
    expectedIntent !== 'local_audience'
    && !directDemand
    && !scheduledEvent
    && !educationalAudienceChannel
    && !venueConsumerDemand
  ) {
    reasons.push('missing_consumer_need_or_event')
  }
  const relevant = expectedIntent === 'local_audience'
    ? housing && laneMatches && localParticipation && reasons.length === 0
    : housing
      && laneMatches
      && (directDemand || scheduledEvent || educationalAudienceChannel || venueConsumerDemand)
      && reasons.length === 0
  return { relevant, demonstratedIntent: intent, reasons: [...new Set(reasons)] }
}

export function canonicalOpportunityUrl(values: unknown): string | null {
  if (!Array.isArray(values)) return null
  for (const entry of values) {
    if (typeof entry !== 'string') continue
    try {
      const url = new URL(entry)
      if (url.protocol !== 'https:') continue
      let host = url.hostname.toLowerCase().replace(/^www\./, '')
      if (host === 'twitter.com' || host === 'mobile.twitter.com') host = 'x.com'
      if (host === 'old.reddit.com' || host === 'new.reddit.com') host = 'reddit.com'
      url.hostname = host
      url.port = ''
      url.hash = ''
      url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/'
      for (const key of [...url.searchParams.keys()]) {
        if (TRACKING_PARAMETER.test(key)) url.searchParams.delete(key)
      }
      const sorted = [...url.searchParams.entries()].sort(([aKey, aValue], [bKey, bValue]) =>
        aKey.localeCompare(bKey) || aValue.localeCompare(bValue),
      )
      url.search = ''
      for (const [key, value] of sorted) url.searchParams.append(key, value)
      return url.toString().replace(/\/$/, '')
    } catch {
      continue
    }
  }
  return null
}

function newestObservedAt(evidence: CandidateEvidence[]): Date | null {
  const values = evidence
    .map((row) => new Date(row.observed_at))
    .filter((date) => Number.isFinite(date.getTime()))
    .sort((left, right) => right.getTime() - left.getTime())
  return values[0] ?? null
}

function validDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

function parsedDate(value: string): Date | null {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

function relativeContentDate(content: string, referenceTime: Date | null): Date | null {
  if (!referenceTime) return null
  const match = content.match(/\b(\d{1,4})\s*(y|yr|yrs|year|years|mo|mos|month|months|w|wk|wks|week|weeks|d|day|days)\s+ago\b/i)
  if (!match) return null
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return null
  const unit = match[2]?.toLowerCase() ?? ''
  const days = unit.startsWith('y')
    ? amount * 365
    : unit.startsWith('mo')
      ? amount * 30
      : unit.startsWith('w')
        ? amount * 7
        : amount
  return new Date(referenceTime.getTime() - days * 86_400_000)
}

function leadingContentDate(content: string): Date | null {
  const monthDate = content.match(new RegExp(`^\\s*(${MONTHS}\\s+\\d{1,2},\\s+20\\d{2})\\s*[—–-]`, 'i'))
  if (monthDate?.[1]) return parsedDate(`${monthDate[1]} UTC`)
  const numericDate = content.match(/^\s*(\d{1,2}\/\d{1,2}\/20\d{2})\s*[—–-]/)
  return numericDate?.[1] ? parsedDate(`${numericDate[1]} UTC`) : null
}

function labeledContentDate(content: string): Date | null {
  const head = content.slice(0, 360)
  const fullDate = head.match(
    new RegExp(
      `\\b(?:published|posted|updated|created|date)\\s*(?:on)?\\s*[:·|—–-]?\\s*(${MONTHS}\\s+\\d{1,2},?\\s+20\\d{2}|\\d{1,2}\\/\\d{1,2}\\/20\\d{2}|20\\d{2}-\\d{1,2}-\\d{1,2})\\b`,
      'i',
    ),
  )
  if (fullDate?.[1]) return parsedDate(`${fullDate[1]} UTC`)

  const leadingMonthYear = head.match(new RegExp(`^\\s*(${MONTHS}\\s+20\\d{2})\\s*[—–-]`, 'i'))
  return leadingMonthYear?.[1] ? parsedDate(`${leadingMonthYear[1]} 1 UTC`) : null
}

function contentPublicationDate(content: string, referenceTime: Date | null): Date | null {
  return relativeContentDate(content, referenceTime)
    ?? leadingContentDate(content)
    ?? labeledContentDate(content)
}

function datedEventCandidates(content: string): Date[] {
  const patterns = [
    new RegExp(`\\b(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)?,?\\s*(${MONTHS}\\s+\\d{1,2},?\\s+20\\d{2})\\b`, 'gi'),
    new RegExp(`\\b(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)?,?\\s*(\\d{1,2}\\s+${MONTHS},?\\s+20\\d{2})\\b`, 'gi'),
    /\b(20\d{2}-\d{1,2}-\d{1,2})\b/g,
    /\b(\d{1,2}\/\d{1,2}\/20\d{2})\b/g,
  ]
  const dates: Date[] = []
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const date = match[1] ? parsedDate(`${match[1]} UTC`) : null
      if (date) dates.push(date)
    }
  }
  return dates
    .filter((date, index, rows) => rows.findIndex((row) => row.getTime() === date.getTime()) === index)
    .sort((left, right) => left.getTime() - right.getTime())
}

/**
 * Resolves the event date from the durable candidate and the bounded public
 * destination evidence. Search snippets often lead with a publication date,
 * while the verified page later names the actual upcoming event. A stale
 * snippet date must not override a demonstrated future event date.
 */
export function resolveOpportunityEventStart(
  explicitValue: unknown,
  content: string,
  referenceTime: Date | null,
): Date | null {
  const explicit = validDate(explicitValue)
  const derived = content ? datedEventCandidates(content) : []
  if (!referenceTime) return explicit ?? derived[0] ?? null
  if (explicit && explicit.getTime() >= referenceTime.getTime()) return explicit
  const future = derived.find((date) => date.getTime() >= referenceTime.getTime())
  return future ?? explicit ?? derived.at(-1) ?? null
}

export function assessOpportunityDestination(args: {
  identity: CandidateIdentity | Record<string, unknown>
  evidence: CandidateEvidence[]
  referenceTime: Date | null
  maxAgeDays: number | null
  content?: string | null
}): OpportunityDestinationAssessment {
  const identity = args.identity as Record<string, unknown>
  const canonicalUrl = canonicalOpportunityUrl([
    identity.url,
    identity.source_url,
    identity.destination_url,
    ...(Array.isArray(identity.urls) ? identity.urls : []),
  ])
  const issues: string[] = []
  if (!canonicalUrl) issues.push('missing_or_invalid_public_destination')
  const content = args.content?.trim() ?? ''
  if (content && INACTIVE_DESTINATION.test(content)) issues.push('destination_inactive')

  const validation = typeof identity.destination_validation_status === 'string'
    ? identity.destination_validation_status
    : null
  if (validation === 'unavailable') issues.push('destination_inactive')
  if (validation === 'blocked') issues.push('destination_validation_blocked')

  const access = typeof identity.access_type === 'string' ? identity.access_type : null
  if (access === 'approval_required') issues.push('destination_requires_approval')
  else if (access === 'unknown' || access == null) issues.push('destination_access_unknown')
  else if (access !== 'public' && access !== 'ticketed') issues.push('destination_not_public')

  const kind = typeof identity.opportunity_kind === 'string' ? identity.opportunity_kind : null
  const published = validDate(identity.source_published_at)
    ?? contentPublicationDate(content, args.referenceTime)
  const eventStart = resolveOpportunityEventStart(
    identity.event_start_at,
    content,
    args.referenceTime,
  )
  // A post/thread's age must come from the platform's publication timestamp.
  // evidence.observed_at is retrieval time and cannot prove that content is
  // inside a play's recency window. Stable destinations such as communities
  // and forums may use the time Noli actually observed the public page.
  const freshnessObservation = kind === 'event'
    ? eventStart ?? published ?? newestObservedAt(args.evidence)
    : published ?? (kind === 'post' || kind === 'thread' ? null : newestObservedAt(args.evidence))
  const ageDays =
    freshnessObservation && args.referenceTime
      ? Math.max(0, (args.referenceTime.getTime() - freshnessObservation.getTime()) / 86_400_000)
      : null
  if (args.maxAgeDays != null && ageDays != null && ageDays > args.maxAgeDays) issues.push('stale_destination')
  if (args.maxAgeDays != null && ageDays == null) issues.push('destination_freshness_unknown')

  if (kind === 'event') {
    if (!eventStart || !Number.isFinite(eventStart.getTime())) issues.push('event_time_unknown')
    else if (args.referenceTime && eventStart.getTime() < args.referenceTime.getTime()) issues.push('event_expired')
  }

  const hardFailure = issues.some((issue) =>
    [
      'missing_or_invalid_public_destination',
      'destination_requires_approval',
      'destination_not_public',
      'destination_inactive',
      'destination_validation_blocked',
      'stale_destination',
      'event_expired',
    ].includes(issue),
  )
  return {
    canonicalUrl,
    status: hardFailure ? 'fail' : issues.length > 0 ? 'unknown' : 'pass',
    issues,
    newestObservation: freshnessObservation?.toISOString() ?? null,
    ageDays,
  }
}

export function calibratedOpportunityConfidence(args: {
  content: string
  sourceUrl: string | null
  observedAt: string
  attemptedAt: string
  engagement: number
  location: string | null
}): number {
  const intent = classifyOpportunityIntentAtDestination(args.content, args.sourceUrl)
  let score = 0.38
  if (args.sourceUrl?.startsWith('https://')) score += 0.12
  if (args.content.trim().length >= 40) score += 0.1
  if (args.content.trim().length >= 120) score += 0.04
  score += intent.confidence * 0.16
  if (args.engagement > 0) score += 0.05
  if (args.engagement >= 5) score += 0.04
  if (args.engagement >= 25) score += 0.03
  if (args.location?.trim()) score += 0.04
  const observed = new Date(args.observedAt)
  const attempted = new Date(args.attemptedAt)
  if (Number.isFinite(observed.getTime()) && Number.isFinite(attempted.getTime())) {
    const ageDays = Math.max(0, (attempted.getTime() - observed.getTime()) / 86_400_000)
    if (ageDays <= 30) score += 0.04
    if (observed.getTime() > attempted.getTime() + 5 * 60_000) score -= 0.25
  }
  return Math.round(Math.max(0.2, Math.min(0.95, score)) * 100) / 100
}

export function opportunityEvidenceText(
  identity: CandidateIdentity | Record<string, unknown>,
  _evidence: CandidateEvidence[],
): string {
  const row = identity as Record<string, unknown>
  // Only provider-returned content belongs in semantic qualification. Several
  // adapters retain the submitted search query in the evidence claim for
  // provenance. Including that claim here lets a targeting term prove its own
  // relevance (and lets negative search operators trigger exclusion rules),
  // recreating the query-leakage defect that content-only intent classification
  // is designed to prevent.
  const identityValues = [
    row.name,
    row.audience_description,
  ].filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
  return identityValues.join('\n')
}

const RANK_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'at', 'for', 'from', 'in', 'is', 'of', 'on', 'or', 'the', 'to', 'us', 'who', 'with',
])

function rankTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !RANK_STOP_WORDS.has(token))
}

function opportunityConversationTokens(
  candidate: Pick<Candidate, 'entity_kind' | 'identity' | 'evidence'>,
): Set<string> {
  if (candidate.entity_kind !== 'opportunity') return new Set()
  const text = opportunityEvidenceText(candidate.identity, candidate.evidence)
    .replace(/\bread more\b/gi, ' ')
  return new Set(rankTokens(text))
}

/**
 * Detects the same public conversation returned through different source
 * paths without collapsing short, generic snippets. URL aliases are exact;
 * text containment requires at least eighteen meaningful tokens and strong
 * overlap in both directions.
 */
export function areRepeatedOpportunityConversations(
  left: Pick<Candidate, 'entity_kind' | 'identity' | 'evidence'>,
  right: Pick<Candidate, 'entity_kind' | 'identity' | 'evidence'>,
): boolean {
  if (left.entity_kind !== 'opportunity' || right.entity_kind !== 'opportunity') return false
  const leftUrl = canonicalOpportunityUrl(left.identity.urls ?? [])
  const rightUrl = canonicalOpportunityUrl(right.identity.urls ?? [])
  if (leftUrl && rightUrl && leftUrl === rightUrl) return true
  const leftTokens = opportunityConversationTokens(left)
  const rightTokens = opportunityConversationTokens(right)
  const smaller = Math.min(leftTokens.size, rightTokens.size)
  const larger = Math.max(leftTokens.size, rightTokens.size)
  if (smaller < 18 || larger === 0) return false
  let overlap = 0
  for (const token of leftTokens) if (rightTokens.has(token)) overlap += 1
  return overlap / smaller >= 0.9 && overlap / larger >= 0.78
}

function overlapScore(expected: string, observed: string): number {
  const wanted = [...new Set(rankTokens(expected))]
  if (wanted.length === 0) return 0
  const actual = new Set(rankTokens(observed))
  return wanted.filter((token) => actual.has(token)).length / wanted.length
}

function requestedIntent(play: {
  audience?: string | null
  signal?: string | null
  providerQuery?: Record<string, unknown> | null
}): DemonstratedOpportunityIntent {
  const explicit = play.providerQuery?.opportunity_intent_lane
  if (
    explicit === 'buyer_intent'
    || explicit === 'seller_intent'
    || explicit === 'local_audience'
    || explicit === 'mixed_intent'
  ) {
    return explicit
  }
  return classifyOpportunityIntent(`${play.audience ?? ''} ${play.signal ?? ''}`).kind
}

/**
 * Evidence-aware deterministic rerank score. This runs only over the provider's
 * already bounded result set and has no model/provider side effect.
 */
export function opportunityRelevanceScore(
  candidate: Pick<Candidate, 'entity_kind' | 'identity' | 'evidence'>,
  play: {
    audience?: string | null
    signal?: string | null
    geography?: string | null
    providerQuery?: Record<string, unknown> | null
    recencyWindow?: string | null
  },
  referenceTime: Date,
): number {
  if (candidate.entity_kind !== 'opportunity') return 0
  const identity = candidate.identity as CandidateIdentity
  const text = opportunityEvidenceText(identity, candidate.evidence)
  const destination = assessOpportunityDestination({
    identity,
    evidence: candidate.evidence,
    referenceTime,
    maxAgeDays: 30,
    content: text,
  })
  const observedIntent = classifyOpportunityIntentAtDestination(text, destination.canonicalUrl).kind
  const intent = requestedIntent(play)
  const audience = `${play.audience ?? ''} ${play.signal ?? ''}`.trim()
  const location = [identity.location, identity.city, identity.region].filter(Boolean).join(' ')
  const geography = play.geography ?? ''
  const engagement = Math.max(0, Number(identity.engagement_count ?? identity.member_count ?? 0))
  const realtorPlay = REALTOR_HOUSING_CONTEXT.test(audience)
  const suitability = assessRealtorOpportunitySuitability(
    text,
    intent,
    destination.canonicalUrl,
    typeof identity.opportunity_kind === 'string' ? identity.opportunity_kind : null,
  )
  const demonstratedLocation = geography
    ? demonstratedOpportunityLocation(`${text}\n${location}`, geography)
    : null
  const contradictoryState = geography
    ? opportunityHasContradictoryUsState(`${text}\n${location}`, geography)
    : false
  const noise = realtorOpportunityNoiseReasons(text, destination.canonicalUrl)

  let score = 0
  score += destination.status === 'pass' ? 15 : destination.status === 'unknown' ? -4 : -35
  score += realtorPlay
    ? suitability.relevant ? 35 : -35
    : Math.min(30, overlapScore(audience, text) * 45)
  score += intent && observedIntent === intent ? 18 : observedIntent == null ? 0 : 3
  score += demonstratedLocation ? 24 : geography ? -12 : 0
  if (contradictoryState) score -= 45
  score += destination.ageDays == null ? 0 : destination.ageDays <= 7 ? 9 : destination.ageDays <= 30 ? 5 : -12
  score += Math.min(5, Math.log10(engagement + 1) * 2.5)
  score -= noise.length * 45
  return Math.round(Math.max(0, Math.min(100, score)) * 100) / 100
}

export function rankOpportunityCandidates<T extends Pick<Candidate, 'entity_kind' | 'identity' | 'evidence'>>(
  candidates: T[],
  play: {
    audience?: string | null
    signal?: string | null
    geography?: string | null
    providerQuery?: Record<string, unknown> | null
    recencyWindow?: string | null
  },
  referenceTime: Date,
): T[] {
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      score: opportunityRelevanceScore(candidate, play, referenceTime),
      destination: canonicalOpportunityUrl(candidate.identity.urls ?? []),
    }))
    .sort((left, right) =>
      right.score - left.score
      || (left.destination ?? '').localeCompare(right.destination ?? '')
      || left.index - right.index,
    )
    .map((row) => row.candidate)
}
