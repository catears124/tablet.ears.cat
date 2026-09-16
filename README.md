# tablet.ears.cat

tablet.ears.cat is a browser-based firmware patcher and configurator for drawing tablets. it installs, restores, and configures supported firmware directly over webusb/webhid.

## supported

- model: gaomon s620
- stock firmware: `OEM02_T18e_241030`
- normal usb: `256C:006F`
- dfu usb: `28E9:0189`
- decoded stock application sha-256: `e4fe509d60c40468f7babe52341de59061266d6956e6f87c619112bd075550dd`
- stock application: `0x08004000`, 35,512 bytes
- runtime rate control: 294–530 hz on the tested tablet
- browser: desktop chromium with webusb + webhid
