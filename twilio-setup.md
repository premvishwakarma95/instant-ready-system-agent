# Twilio Setup

## 1. Twilio Account
Need: An active Twilio account.
Steps:
1. Go to twilio.com and sign up.
2. Verify your email and phone number.
3. Add a payment method.

## 2. Phone Number (Area Code 757)
Need: A phone number in area code 757 for Everly to call from.
Steps:
1. In Twilio Console, go to Phone Numbers → Buy a Number.
2. Search area code 757.
3. Purchase the number.

## 3. Business Verification (Trust Hub)
Need: A verified business profile so outbound calls aren't flagged as spam.
Steps:
1. Go to Trust Hub in Twilio Console.
2. Create a Business Profile.
3. Submit company name, address, and business documents.
4. Wait for approval.

## 4. SHAKEN/STIR + Voice Integrity
Need: Trusted-calling registration to protect call answer rates.
Why: Everly may call the same carrier up to 4 times per load — that pattern can get the number auto-flagged "Spam Likely" by carrier phones, killing answer rates. This proves the calls are really from MDR and lets us monitor/fix the number's reputation if it happens anyway.
Steps:
1. After Business Profile approval, go to Voice → Trusted Calling.
2. Enable SHAKEN/STIR.
3. Enable Voice Integrity monitoring.

## 5. Account SID and Auth Token
Need: Credentials so we can connect the number to Vapi.
Steps:
1. Go to the Console Dashboard.
2. Copy the Account SID and Auth Token.
3. Send them to us securely.
