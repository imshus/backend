/**
 * The app's FAQ, transcribed from the owner's voice notes.
 *
 * Every question and answer is written twice, in English and in Hindi, so a
 * screen can show whichever the reader wants without a translation call. The
 * sections follow the order the app's settings are arranged in.
 *
 * This is editorial content, not per-business data: it is the same for every
 * shop, so it lives in the source and is served as it is. Editing it is a
 * deploy, which is the right cost for something that changes a few times a
 * year; if it ever needs editing from the app, it moves to a collection.
 */
const FAQ_SECTIONS = [
  {
    section: { en: 'Gold', hi: 'सोना' },
    items: [
      {
        q: {
          en: 'Can I choose my preferred Bullion source?',
          hi: 'क्या मैं अपना पसंदीदा Bullion source चुन सकता हूं?',
        },
        a: {
          en: 'Yes. Dashboard Settings → Choose Bullion Source → select the one you want to show your rates.',
          hi: 'हां। Dashboard Settings → Choose Bullion Source → जो source अपनी rates के लिए चाहिए, उसे select करें।',
        },
      },
      {
        q: {
          en: 'Can I add my preferred Bullion source?',
          hi: 'क्या मैं अपना पसंदीदा Bullion source जोड़ सकता हूं?',
        },
        a: {
          en: 'Yes. Dashboard Settings → Choose Bullion Source → add your preferred source. We’ll get the required information and update you once it’s done.',
          hi: 'हां। Dashboard Settings → Choose Bullion Source → अपना पसंदीदा source add करें। जरूरी जानकारी लेकर हमारी टीम आपको अपडेट कर देगी।',
        },
      },
      {
        q: {
          en: 'How can I choose which rates are shown on my dashboard?',
          hi: 'मैं अपने dashboard पर कौन-सी rates दिखानी हैं, यह कैसे चुनूं?',
        },
        a: {
          en: 'Dashboard Settings → select the Cash and RTGS rates you want for 24K, 22K, 20K, 18K, 14K and 9K gold. They’ll show up on your dashboard.',
          hi: 'Dashboard Settings → 24K, 22K, 20K, 18K, 14K और 9K सोने की जो Cash और RTGS rates चाहिए, उन्हें select करें। वो आपके dashboard पर दिखने लगेंगी।',
        },
      },
      {
        q: {
          en: 'Can I change the MCX, Cash and RTGS rates that are shown by default?',
          hi: 'क्या मैं default दिखने वाली MCX, Cash और RTGS rates बदल सकता हूं?',
        },
        a: {
          en: 'Yes. Dashboard Settings → Masters → Gold → Rates → add or subtract the amount you want. The updated rate will be shown on your dashboard from then on.',
          hi: 'हां। Dashboard Settings → Masters → Gold → Rates → जितना amount चाहिए उतना add या minus करें। यह नई rate तभी से आपके dashboard पर दिखेगी।',
        },
      },
      {
        q: {
          en: 'Can I change the purity percentage of gold?',
          hi: 'क्या मैं सोने की purity percentage बदल सकता हूं?',
        },
        a: {
          en: 'Yes, for 22K, 18K, 14K and 9K gold. Dashboard Settings → Masters → Gold → edit the purity percentage for each karat. This percentage will be used every time you calculate MRP.',
          hi: 'हां, 22K, 18K, 14K और 9K सोने के लिए। Dashboard Settings → Masters → Gold → हर karat की purity percentage edit करें। यह percentage हर बार MRP calculate करते समय इस्तेमाल होगी।',
        },
      },
      {
        q: {
          en: 'How can I choose RTGS or Cash rate while calculating MRP?',
          hi: 'MRP calculate करते समय RTGS या Cash rate कैसे चुनूं?',
        },
        a: {
          en: 'After scanning the tag, go to the Gold section → tap RTGS or Cash rate. The MRP will be calculated using that rate automatically.',
          hi: 'Tag scan करने के बाद, Gold section में जाकर RTGS या Cash rate पर tap करें। MRP उसी rate से automatically calculate हो जाएगी।',
        },
      },
    ],
  },
  {
    section: { en: 'Diamond', hi: 'हीरा' },
    items: [
      {
        q: {
          en: 'How can I add predefined diamond rates for a particular shape, sieve, color or clarity?',
          hi: 'किसी particular shape, sieve, color या clarity के लिए predefined diamond rates कैसे add करूं?',
        },
        a: {
          en: 'Settings → Masters → Diamond → Add Diamond Rates → fill in the required columns to add rates.',
          hi: 'Settings → Masters → Diamond → Add Diamond Rates → जरूरी columns भरकर rates add करें।',
        },
      },
      {
        q: {
          en: 'If I have a diamond packet code written on my tag, can I add it?',
          hi: 'अगर मेरे tag पर diamond packet code लिखा है, तो क्या मैं उसे add कर सकता हूं?',
        },
        a: {
          en: 'Yes. Settings → Masters → Diamond → Add Diamond Rates → enter the packet code and its rate in the Packet Code column. This rate will be applied automatically whenever the scanner detects this packet code.',
          hi: 'हां। Settings → Masters → Diamond → Add Diamond Rates → Packet Code column में packet code और उसकी rate डालें। जब भी scanner यह packet code scan करेगा, यह rate automatically लग जाएगी।',
        },
      },
      {
        q: {
          en: 'What if I have two diamond packet codes on a single piece of jewellery?',
          hi: 'अगर एक ही जूलरी पर दो diamond packet codes हों तो क्या होगा?',
        },
        a: {
          en: 'The scanner will automatically detect both diamonds. While calculating MRP, it will show both weights and rates separately.',
          hi: 'Scanner दोनों diamonds को automatically detect कर लेगा। MRP calculate करते समय दोनों का weight और rate अलग-अलग दिखेगा।',
        },
      },
      {
        q: {
          en: 'What if I have a predefined rate in my diamond masters, but I want to edit it while calculating MRP for a customer?',
          hi: 'अगर मेरे diamond masters में predefined rate है, पर मैं customer के हिसाब से MRP calculate करते समय rate बदलना चाहूं तो?',
        },
        a: {
          en: 'You can always edit the rate while calculating MRP. The scanner fetches the predefined rate from Masters first, but you can change it at that time.',
          hi: 'MRP calculate करते समय आप हमेशा rate edit कर सकते हैं। Scanner पहले Masters से predefined rate उठाएगा, पर आप उस समय उसे बदल सकते हैं।',
        },
      },
    ],
  },
  {
    section: { en: 'Colorstone', hi: 'कलरस्टोन' },
    items: [
      {
        q: {
          en: 'What if I have a colorstone on my tag?',
          hi: 'अगर मेरे tag पर colorstone है तो क्या होगा?',
        },
        a: {
          en: 'The scanner will automatically detect the colorstone and its weight on scanning. If the rate is written on the tag, it will fetch that — otherwise, the rate will be taken from the backend.',
          hi: 'Scan करते ही scanner colorstone और उसका weight automatically detect कर लेगा। अगर rate tag पर लिखी है तो वो ले लेगा — नहीं तो rate backend से आएगी।',
        },
      },
      {
        q: {
          en: 'How do I add predefined colorstone rates?',
          hi: 'Predefined colorstone rates कैसे add करूं?',
        },
        a: {
          en: 'Settings → Masters → Colorstone → add your predefined rates there.',
          hi: 'Settings → Masters → Colorstone → अपनी predefined rates यहां add करें।',
        },
      },
      {
        q: {
          en: 'How can I edit colorstone rates while calculating MRP?',
          hi: 'MRP calculate करते समय colorstone rate कैसे edit करूं?',
        },
        a: {
          en: 'Just change the colorstone rate while calculating MRP — it updates automatically.',
          hi: 'बस MRP calculate करते समय colorstone rate बदल दें — यह automatically update हो जाएगी।',
        },
      },
      {
        q: {
          en: 'What if I don’t put a colorstone rate on my tag, and it’s also not in my Masters column?',
          hi: 'अगर मैं tag पर colorstone rate नहीं डालता, और वो मेरे Masters column में भी नहीं है, तो क्या होगा?',
        },
        a: {
          en: 'The colorstone will still be detected by the scanner, but the rate column will be empty. Just enter your desired rate, and the MRP will be calculated automatically.',
          hi: 'Scanner फिर भी colorstone detect कर लेगा, पर rate column खाली रहेगा। बस अपनी मनचाही rate डाल दें, MRP automatically calculate हो जाएगी।',
        },
      },
    ],
  },
  {
    section: { en: 'Labour Charge', hi: 'लेबर चार्ज' },
    items: [
      {
        q: {
          en: 'What if there is no labour charge written on my tag?',
          hi: 'अगर मेरे tag पर labour charge नहीं लिखा है तो क्या होगा?',
        },
        a: {
          en: 'After scanning the tag, the labour charge field will show blank. Just enter your labour rate and select Gross Weight or Net Weight — the labour charge will be calculated automatically.',
          hi: 'Tag scan करने के बाद labour charge field खाली दिखेगा। बस अपनी labour rate डालें और Gross Weight या Net Weight चुनें — labour charge automatically calculate हो जाएगा।',
        },
      },
      {
        q: {
          en: 'Can I predefine labour charges for my tags?',
          hi: 'क्या मैं अपने tags के लिए labour charges predefine कर सकता हूं?',
        },
        a: {
          en: 'Yes. Settings → Masters → Labour Charges → add your desired labour rate and select Gross Weight or Net Weight. This will be saved in your Masters and used every time you calculate MRP.',
          hi: 'हां। Settings → Masters → Labour Charges → अपनी मनचाही labour rate डालें और Gross Weight या Net Weight चुनें। यह Masters में save हो जाएगा और हर बार MRP calculate करते समय इस्तेमाल होगा।',
        },
      },
    ],
  },
  {
    section: { en: 'Item Code', hi: 'आइटम कोड' },
    items: [
      {
        q: {
          en: 'How do I add an item code?',
          hi: 'Item code कैसे add करूं?',
        },
        a: {
          en: 'Settings → Masters → Item Code → add your item name and item code. Whenever the scanner scans a matching tag, it will automatically fetch the item name and code and show them on the calculation page.',
          hi: 'Settings → Masters → Item Code → अपना item name और item code add करें। जब भी scanner matching tag scan करेगा, item name और code automatically calculation page पर दिख जाएंगे।',
        },
      },
    ],
  },
  {
    section: { en: 'Generate Invoice', hi: 'इनवॉइस जनरेट करना' },
    items: [
      {
        q: {
          en: 'Can I generate an e-invoice from this app?',
          hi: 'क्या मैं इस app से e-invoice generate कर सकता हूं?',
        },
        a: {
          en: 'Yes, but you’ll need to submit a few documents required on the GST portal. Email info@mrpscan.com mentioning that you want the e-invoice facility, and our team will connect with you to set it up.',
          hi: 'हां, पर उसके लिए आपको GST portal पर जरूरी कुछ documents submit करने होंगे। info@mrpscan.com पर email करें कि आपको e-invoice facility चाहिए, हमारी टीम आपसे contact करके इसे शुरू कर देगी।',
        },
      },
      {
        q: {
          en: 'Can I send my invoice to another person?',
          hi: 'क्या मैं अपना invoice किसी और को भेज सकता हूं?',
        },
        a: {
          en: 'Yes. Generate Invoice → Preview → use the sharing option there to send the invoice to your customer.',
          hi: 'हां। Generate Invoice → Preview → वहां दिए गए sharing option से customer को invoice भेज सकते हैं।',
        },
      },
    ],
  },
  {
    section: { en: 'Wishlist', hi: 'विशलिस्ट' },
    items: [
      {
        q: {
          en: 'After calculating the MRP, can I add it to my wishlist?',
          hi: 'MRP calculate करने के बाद, क्या मैं उसे wishlist में add कर सकता हूं?',
        },
        a: {
          en: 'Yes. Scan your tag, calculate the MRP, and tap Add to Wishlist at the bottom. It will be saved in your wishlist, shown on the Home page — and you can clear it out anytime.',
          hi: 'हां। Tag scan करें, MRP calculate करें, और नीचे दिए Add to Wishlist पर tap करें। यह आपकी wishlist में save हो जाएगा, जो Home page पर दिखती है — और आप इसे कभी भी clear कर सकते हैं।',
        },
      },
    ],
  },
  {
    section: { en: 'Password Manager', hi: 'पासवर्ड मैनेजर' },
    items: [
      {
        q: {
          en: 'Can I change my password?',
          hi: 'क्या मैं अपना password बदल सकता हूं?',
        },
        a: {
          en: 'Yes, you can always change or update your password. Go to Password Manager and create your new password there.',
          hi: 'हां, आप हमेशा अपना password बदल या update कर सकते हैं। Password Manager में जाकर अपना नया password बनाएं।',
        },
      },
    ],
  },
  {
    section: { en: 'Employee Management', hi: 'एम्प्लॉई मैनेजमेंट' },
    items: [
      {
        q: {
          en: 'How can I add an employee to my app?',
          hi: 'मैं अपने app में employee कैसे add करूं?',
        },
        a: {
          en: 'Settings → Employee Manager → Add New Employee → fill in their details → Continue. A unique username and password will be generated for them — share it directly from there, and it becomes their login.',
          hi: 'Settings → Employee Manager → Add New Employee → उनकी details भरें → Continue। उनके लिए एक unique username और password बन जाएगा — इसे वहीं से share कर दें, यही उनका login बन जाएगा।',
        },
      },
      {
        q: {
          en: 'Can my employee use two different IDs on this app?',
          hi: 'क्या मेरा employee इस app पर दो अलग-अलग IDs इस्तेमाल कर सकता है?',
        },
        a: {
          en: 'No — only one login is allowed per employee, tied to one mobile number under your GST license.',
          hi: 'नहीं — हर employee का सिर्फ एक ही login होगा, जो आपके GST license के तहत एक mobile number से जुड़ा होगा।',
        },
      },
      {
        q: {
          en: 'How can I control which gold rate tiles are shown to my employee?',
          hi: 'मैं अपने employee को दिखने वाली gold rate tiles कैसे control करूं?',
        },
        a: {
          en: 'Settings → Employee Manager → select the employee → Set Permission → Dashboard Matrices → select the gold rates you want them to see. Only the rates you select will show up in their app.',
          hi: 'Settings → Employee Manager → employee चुनें → Set Permission → Dashboard Matrices → जो gold rates उन्हें दिखानी हैं वो select करें। सिर्फ selected rates ही उनके app में दिखेंगी।',
        },
      },
      {
        q: {
          en: 'How can I make sure my employee cannot change the gold rates?',
          hi: 'मैं कैसे पक्का करूं कि मेरा employee gold rates ना बदल सके?',
        },
        a: {
          en: 'Settings → Employee Manager → select the employee → Set Permission → Give Rate Edit Access → leave Gold unchecked. If it’s unchecked, they won’t be able to edit gold rates.',
          hi: 'Settings → Employee Manager → employee चुनें → Set Permission → Give Rate Edit Access → Gold को unchecked रहने दें। Unchecked रहने पर वो gold rates edit नहीं कर पाएंगे।',
        },
      },
      {
        q: {
          en: 'How can I make sure my employee cannot change the diamond rates?',
          hi: 'मैं कैसे पक्का करूं कि मेरा employee diamond rates ना बदल सके?',
        },
        a: {
          en: 'Settings → Employee Manager → select the employee → Set Permission → Give Rate Edit Access → leave Diamond unchecked. If it’s checked, they can edit diamond rates — if not, they can’t.',
          hi: 'Settings → Employee Manager → employee चुनें → Set Permission → Give Rate Edit Access → Diamond को unchecked रहने दें। Checked होने पर वो diamond rates edit कर सकते हैं — नहीं तो नहीं।',
        },
      },
      {
        q: {
          en: 'How can I make sure my employee cannot change the labour rates?',
          hi: 'मैं कैसे पक्का करूं कि मेरा employee labour rates ना बदल सके?',
        },
        a: {
          en: 'Settings → Employee Manager → select the employee → Set Permission → Give Rate Edit Access → leave Labour Charges unchecked to stop them from editing labour rates while calculating MRP.',
          hi: 'Settings → Employee Manager → employee चुनें → Set Permission → Give Rate Edit Access → Labour Charges को unchecked रखें ताकि वो MRP calculate करते समय labour rates edit ना कर सकें।',
        },
      },
      {
        q: {
          en: 'How can I make sure my employee sees only RTGS rate, only Cash rate, or both?',
          hi: 'मैं कैसे पक्का करूं कि मेरा employee सिर्फ RTGS rate, सिर्फ Cash rate, या दोनों देख सके?',
        },
        a: {
          en: 'Settings → Employee Manager → select the employee → Set Permission → Gold Rate Options While Calculating → choose RTGS Rate Only, Cash Rate Only, or Both. This controls what’s shown in their app.',
          hi: 'Settings → Employee Manager → employee चुनें → Set Permission → Gold Rate Options While Calculating → RTGS Rate Only, Cash Rate Only, या Both में से चुनें। इससे तय होगा कि उनके app में क्या दिखेगा।',
        },
      },
      {
        q: {
          en: 'How can I make sure my employee cannot edit the purity percentage while calculating MRP?',
          hi: 'मैं कैसे पक्का करूं कि मेरा employee MRP calculate करते समय purity percentage edit ना कर सके?',
        },
        a: {
          en: 'Settings → Employee Manager → select the employee → Set Permission → leave Edit Purity (%) unchecked to stop them from changing the purity percentage while calculating MRP.',
          hi: 'Settings → Employee Manager → employee चुनें → Set Permission → Edit Purity (%) को unchecked रखें ताकि वो MRP calculate करते समय purity percentage ना बदल सकें।',
        },
      },
      {
        q: {
          en: 'What if my employee leaves my company?',
          hi: 'अगर मेरा employee कंपनी छोड़ दे तो क्या करूं?',
        },
        a: {
          en: 'Settings → Employee Manager → tap the employee’s card → turn off Active Account. All app features will be disabled for that employee’s number.',
          hi: 'Settings → Employee Manager → employee के card पर tap करें → Active Account को off कर दें। उस employee के number पर app के सारे features disable हो जाएंगे।',
        },
      },
    ],
  },
];

module.exports = { FAQ_SECTIONS };
