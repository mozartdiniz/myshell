# The Translator applet's window, run by gjs from the Translator applet
install_data('main.js', install_dir: pkgdatadir / 'translator')

translatorconf = configuration_data()
translatorconf.set('gjs', gjs.full_path())
translatorconf.set('pkgdatadir', pkgdatadir)

configure_file(
  input: 'org.tessera.Translator.desktop.in',
  output: 'org.tessera.Translator.desktop',
  configuration: translatorconf,
  install_dir: desktopdir,
)
