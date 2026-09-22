function pi --wraps pi --description 'pi with bot profiles (pi --bot <name>)'
    set -l bots_dir (set -q PI_BOTS_DIR; and echo $PI_BOTS_DIR; or echo $HOME/dev/pi-bots)
    set -l idx (contains -i -- --bot $argv)
    if test -n "$idx"
        set -l name $argv[(math $idx + 1)]
        if test -d "$bots_dir/$name"
            set -e argv[(math $idx + 1)]
            set -e argv[$idx]
            command pi-bot $name $argv
            return
        end
    end
    command pi $argv
end
